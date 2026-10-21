import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import {
  admit as admitJob,
  admitWithoutHold,
  chargeStep,
  chooseLimit,
  cycleOf,
  DEFAULT_LIMIT,
  FEATURE,
  HOLD_TTL_MS,
  JOBS_PER_MINUTE,
  limitIsFresh,
  remainingOf,
  validCycleStart,
} from "./lib/core";
import { guard } from "./lib/guard";
import { budgetFor, settleJob } from "./lib/jobs";
import { providerIsKinde, readKindeLimit } from "./lib/provider";
import { retryConflicts } from "./lib/retry";

export const planValidator = v.object({
  actual: v.number(),
  stepTokens: v.number(),
  stepMs: v.number(),
  failAfter: v.optional(v.number()),
  crashAfter: v.optional(v.number()),
});
const modeValidator = v.union(v.literal("earmark"), v.literal("naive"));

async function billingOf(ctx: Pick<QueryCtx, "db">, ownerId: string): Promise<Doc<"billing"> | null> {
  return await ctx.db.query("billing").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).unique();
}

/** What an account's limit looks like right now, for the action that decides whether to ask the provider. */
export const limitState = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    const billing = await billingOf(ctx, ownerId);
    return {
      limit: billing?.limit ?? null,
      checkedAt: billing?.limitCheckedAt ?? null,
      customerId: billing?.customerId ?? null,
      featureCode: billing?.featureCode ?? FEATURE,
    };
  },
});

export const storeLimit = internalMutation({
  args: { ownerId: v.string(), limit: v.number() },
  handler: async (ctx, { ownerId, limit }) => {
    const billing = await billingOf(ctx, ownerId);
    if (billing) await ctx.db.patch(billing._id, { limit, limitCheckedAt: Date.now() });
    else await ctx.db.insert("billing", { ownerId, featureCode: FEATURE, limit, limitCheckedAt: Date.now() });
  },
});

export interface Admitted {
  jobId: Id<"jobs">;
  admitted: boolean;
  duplicate: boolean;
  reason: string | undefined;
  remaining: number;
}

interface AdmitArgs {
  ownerId: string;
  key: string;
  label: string;
  estimate: number;
  mode: "earmark" | "naive";
  plan?: Doc<"jobs">["plan"];
  blockedReason?: string;
}

/**
 * The gate. In one transaction: read the budget, check that the whole hold fits, and take the hold.
 * Convex runs a transaction as if no other one ran at the same time, so two jobs cannot both be promised the same capacity.
 */
export const admit = internalMutation({
  args: {
    ownerId: v.string(),
    key: v.string(),
    label: v.string(),
    estimate: v.number(),
    mode: modeValidator,
    plan: v.optional(planValidator),
    blockedReason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Admitted> => {
    const now = Date.now();
    const same = await ctx.db.query("jobs").withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key)).unique();
    if (same) {
      const budget = await budgetFor(ctx, args.ownerId, same.cycle);
      const billing = await billingOf(ctx, args.ownerId);
      return { jobId: same._id, admitted: same.status !== "refused", duplicate: true, reason: same.reason, remaining: remainingOf({ limit: billing?.limit ?? DEFAULT_LIMIT, used: budget.used, held: budget.held }) };
    }
    let billing = await billingOf(ctx, args.ownerId);
    if (!billing) {
      const id = await ctx.db.insert("billing", { ownerId: args.ownerId, featureCode: FEATURE, limit: providerIsKinde() ? undefined : DEFAULT_LIMIT });
      billing = (await ctx.db.get(id))!;
    }
    // The rate check reads one counter. Reading the recent job rows instead would make every running job's progress conflict with every new admission.
    const fresh = billing.windowStart !== undefined && now - billing.windowStart < 60_000;
    const count = fresh ? (billing.windowCount ?? 0) : 0;
    if (count >= JOBS_PER_MINUTE) throw new Error(`Slow down. An account can start ${JOBS_PER_MINUTE} jobs a minute.`);
    await ctx.db.patch(billing._id, { windowStart: fresh ? billing.windowStart : now, windowCount: count + 1 });
    const cycle = cycleOf(now, billing.cycleStart);
    const budget = await budgetFor(ctx, args.ownerId, cycle);
    const limit = billing.limit;

    let decision;
    if (args.blockedReason || limit === undefined) {
      decision = { admitted: false as const, remaining: 0, reason: args.blockedReason ?? "The plan limit is not known yet." };
    } else {
      const state = { limit, used: budget.used, held: budget.held };
      decision = args.mode === "naive" ? admitWithoutHold(state, args.estimate) : admitJob(state, args.estimate);
    }

    const base = { ownerId: args.ownerId, key: args.key, label: args.label.slice(0, 80), cycle, estimate: args.estimate, used: 0, mode: args.mode, createdAt: now, leaseUntil: now + HOLD_TTL_MS, plan: args.plan };
    if (!decision.admitted) {
      const jobId = await ctx.db.insert("jobs", { ...base, held: 0, status: "refused", reason: decision.reason, settledAt: now });
      return { jobId, admitted: false, duplicate: false, reason: decision.reason, remaining: decision.remaining };
    }
    const held = args.mode === "naive" ? 0 : args.estimate;
    if (held > 0) await ctx.db.patch(budget._id, { held: budget.held + held });
    const jobId = await ctx.db.insert("jobs", { ...base, held, status: "running" });
    return { jobId, admitted: true, duplicate: false, reason: undefined, remaining: decision.remaining };
  },
});

/** Decide which limit to trust, then run the gate. The provider is asked at most once a minute for each account. */
export async function submitJob(ctx: ActionCtx, args: AdmitArgs & { mode?: "earmark" | "naive" }): Promise<Admitted> {
  const mode = args.mode ?? "earmark";
  if (mode === "naive" && providerIsKinde()) throw new Error("The unsafe mode is only for the built-in provider.");
  let blockedReason: string | undefined;
  if (providerIsKinde()) {
    const state = await ctx.runQuery(internal.gate.limitState, { ownerId: args.ownerId });
    if (!limitIsFresh(state, Date.now())) {
      const read = await readKindeLimit({ customerId: state.customerId ?? undefined, featureCode: state.featureCode });
      const decision = chooseLimit(state, read, Date.now());
      if (read.kind === "fresh") await ctx.runMutation(internal.gate.storeLimit, { ownerId: args.ownerId, limit: read.limit });
      else if (decision.use === null) blockedReason = decision.reason;
    }
  }
  // Many jobs at once all touch the same budget row. A conflict is retried, and the retry is safe because the key makes admission repeatable.
  const result: Admitted = await retryConflicts(() => ctx.runMutation(internal.gate.admit, { ...args, mode, blockedReason }));
  if (result.admitted && !result.duplicate) await ctx.scheduler.runAfter(0, internal.work.run, { jobId: result.jobId });
  return result;
}

export const submit = action({
  args: {
    serverKey: v.string(),
    ownerId: v.string(),
    key: v.string(),
    label: v.string(),
    estimate: v.number(),
    mode: v.optional(modeValidator),
    plan: v.optional(planValidator),
  },
  handler: async (ctx, { serverKey, ...args }): Promise<Admitted> => {
    guard(serverKey);
    return await submitJob(ctx, { ...args, mode: args.mode ?? "earmark" });
  },
});

export const getJob = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => await ctx.db.get(jobId),
});

/** A running job charges for a step of work. It can never spend past its hold, and each charge renews the hold. */
export const spend = internalMutation({
  args: { jobId: v.id("jobs"), tokens: v.number() },
  handler: async (ctx, { jobId, tokens }) => {
    const job = await ctx.db.get(jobId);
    // A job that was settled, or whose hold lapsed, cannot spend. A worker that came back late stops here.
    if (!job || job.status !== "running") return { charged: 0, capped: true, live: false };
    const step = job.mode === "naive" ? { charged: Math.max(0, Math.floor(tokens)), capped: false } : chargeStep(job.held, job.used, tokens);
    await ctx.db.patch(jobId, { used: job.used + step.charged, leaseUntil: Date.now() + HOLD_TTL_MS });
    return { ...step, live: true };
  },
});

export const finish = internalMutation({
  args: { jobId: v.id("jobs"), status: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("capped")), reason: v.optional(v.string()) },
  handler: async (ctx, { jobId, status, reason }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return null;
    return await settleJob(ctx, job, status, reason);
  },
});

/** A worker that stopped leaves its hold behind. When the lease runs out, the job is settled at what it used and the rest goes back. */
export const expire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const lapsed = await ctx.db.query("jobs").withIndex("by_status_lease", (q) => q.eq("status", "running").lt("leaseUntil", Date.now())).take(100);
    for (const job of lapsed) await settleJob(ctx, job, "expired", "The worker stopped reporting, so the hold ran out. The job was charged for what it used.");
    return lapsed.length;
  },
});

/** The dashboard: the limit, the budget for this cycle, and the latest jobs and settlements. */
export const overview = query({
  args: { serverKey: v.string(), ownerId: v.string() },
  handler: async (ctx, { serverKey, ownerId }) => {
    guard(serverKey);
    const billing = await billingOf(ctx, ownerId);
    const now = Date.now();
    const cycle = cycleOf(now, billing?.cycleStart);
    const budget = await ctx.db.query("budgets").withIndex("by_owner_cycle", (q) => q.eq("ownerId", ownerId).eq("cycle", cycle)).unique();
    const report = await ctx.db.query("reports").withIndex("by_owner_cycle", (q) => q.eq("ownerId", ownerId).eq("cycle", cycle)).unique();
    const limit = billing?.limit ?? (providerIsKinde() ? null : DEFAULT_LIMIT);
    const used = budget?.used ?? 0;
    const held = budget?.held ?? 0;
    const jobs = await ctx.db.query("jobs").withIndex("by_owner_created", (q) => q.eq("ownerId", ownerId)).order("desc").take(30);
    const settlements = await ctx.db.query("settlements").withIndex("by_owner_at", (q) => q.eq("ownerId", ownerId)).order("desc").take(10);
    return {
      provider: providerIsKinde() ? ("kinde" as const) : ("builtin" as const),
      billing: { limit, limitCheckedAt: billing?.limitCheckedAt ?? null, customerId: billing?.customerId ?? null, agreementId: billing?.agreementId ?? null, featureCode: billing?.featureCode ?? FEATURE, cycleStart: billing?.cycleStart ?? null },
      budget: { cycle, limit, used, held, remaining: limit === null ? null : remainingOf({ limit, used, held }), meter: report?.meter ?? null, reported: report?.reported ?? null, dirty: report?.dirty ?? false, reportError: report?.reportError ?? null },
      jobs: jobs.map((j) => ({ id: j._id as Id<"jobs">, key: j.key, label: j.label, status: j.status, mode: j.mode, estimate: j.estimate, held: j.held, used: j.used, reason: j.reason ?? null, createdAt: j.createdAt, settledAt: j.settledAt ?? null })),
      settlements: settlements.map((s) => ({ id: s._id, jobId: s.jobId, held: s.held, charged: s.charged, released: s.released, status: s.status, at: s.at })),
    };
  },
});

/** Built-in provider only: change the plan limit by hand, the way a plan change in Kinde would. */
export const setLimit = mutation({
  args: { serverKey: v.string(), ownerId: v.string(), limit: v.number() },
  handler: async (ctx, { serverKey, ownerId, limit }) => {
    guard(serverKey);
    if (providerIsKinde()) throw new Error("With Kinde, the limit comes from the customer's plan. Change the plan in Kinde.");
    if (!Number.isInteger(limit) || limit < 0 || limit > 1_000_000_000) throw new Error("The limit must be a whole number from 0 to 1,000,000,000.");
    const billing = await billingOf(ctx, ownerId);
    if (billing) await ctx.db.patch(billing._id, { limit, limitCheckedAt: Date.now() });
    else await ctx.db.insert("billing", { ownerId, featureCode: FEATURE, limit, limitCheckedAt: Date.now() });
    return { limit };
  },
});

/** Kinde only: tell Earmark which billing customer's plan sets the limit, and which agreement the usage is reported to. */
export const connect = mutation({
  args: { serverKey: v.string(), ownerId: v.string(), customerId: v.string(), agreementId: v.string(), featureCode: v.string(), cycleStart: v.optional(v.number()) },
  handler: async (ctx, { serverKey, ownerId, customerId, agreementId, featureCode, cycleStart }) => {
    guard(serverKey);
    if (!providerIsKinde()) throw new Error("Set PROVIDER to kinde on the Convex deployment first.");
    if (cycleStart !== undefined && !validCycleStart(cycleStart)) throw new Error("Use an agreement start on the 1st to the 28th of a month, in UTC.");
    const billing = await billingOf(ctx, ownerId);
    const anyJob = await ctx.db.query("jobs").withIndex("by_owner_created", (q) => q.eq("ownerId", ownerId)).first();
    if (anyJob && cycleStart !== undefined && billing?.cycleStart !== cycleStart) {
      throw new Error("The agreement start is set before the first job. This account already has jobs.");
    }
    const fields = { featureCode, customerId, agreementId, cycleStart: cycleStart ?? billing?.cycleStart, limit: undefined, limitCheckedAt: undefined };
    if (billing) await ctx.db.replace(billing._id, { ownerId, ...fields });
    else await ctx.db.insert("billing", { ownerId, ...fields });
    return { connected: true };
  },
});
