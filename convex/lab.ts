import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { FEATURE } from "./lib/core";
import { guard } from "./lib/guard";
import { providerIsKinde } from "./lib/provider";
import { submitJob, type Admitted } from "./gate";

export interface RaceResult {
  mode: "earmark" | "naive";
  limit: number;
  estimate: number;
  jobs: number;
  admitted: number;
  refused: number;
  spent: number;
  over: number;
  running: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const seed = internalMutation({
  args: { ownerId: v.string(), limit: v.number() },
  handler: async (ctx, { ownerId, limit }) => {
    await ctx.db.insert("billing", { ownerId, featureCode: FEATURE, limit, limitCheckedAt: Date.now() });
  },
});

/** What the scratch account has spent so far, and how many of its jobs are still running. */
export const view = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }): Promise<{ used: number; running: number }> => {
    const jobs = await ctx.db.query("jobs").withIndex("by_owner_created", (q) => q.eq("ownerId", ownerId)).take(100);
    return { used: jobs.reduce((sum, j) => sum + j.used, 0), running: jobs.filter((j) => j.status === "running").length };
  },
});

/** Delete the scratch accounts that the lab made. Real accounts never start with "lab_". */
export const purge = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 60 * 60_000;
    let removed = 0;
    for (const job of await ctx.db.query("jobs").withIndex("by_owner_created", (q) => q.gte("ownerId", "lab_").lt("ownerId", "lab`")).take(500)) {
      if (job._creationTime > cutoff) continue;
      await ctx.db.delete(job._id);
      removed++;
    }
    for (const row of await ctx.db.query("settlements").withIndex("by_owner_at", (q) => q.gte("ownerId", "lab_").lt("ownerId", "lab`")).take(500)) {
      if (row._creationTime > cutoff) continue;
      await ctx.db.delete(row._id);
      removed++;
    }
    for (const row of await ctx.db.query("budgets").withIndex("by_owner_cycle", (q) => q.gte("ownerId", "lab_").lt("ownerId", "lab`")).take(500)) {
      if (row._creationTime > cutoff) continue;
      await ctx.db.delete(row._id);
      removed++;
    }
    for (const row of await ctx.db.query("reports").withIndex("by_owner_cycle", (q) => q.gte("ownerId", "lab_").lt("ownerId", "lab`")).take(500)) {
      if (row._creationTime > cutoff) continue;
      await ctx.db.delete(row._id);
      removed++;
    }
    for (const row of await ctx.db.query("billing").withIndex("by_owner", (q) => q.gte("ownerId", "lab_").lt("ownerId", "lab`")).take(500)) {
      if (row._creationTime > cutoff) continue;
      await ctx.db.delete(row._id);
      removed++;
    }
    return removed;
  },
});

/**
 * The Concurrency Lab. It makes a scratch account with a limit, starts several jobs at the same moment, waits for them to end,
 * and reports what was spent. Run it once with "naive" and once with "earmark" to see the difference.
 */
export const race = action({
  args: { serverKey: v.string(), mode: v.union(v.literal("earmark"), v.literal("naive")), jobs: v.optional(v.number()), estimate: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { serverKey, mode, jobs = 5, estimate = 40_000, limit = 100_000 }): Promise<RaceResult> => {
    guard(serverKey);
    if (providerIsKinde()) throw new Error("The lab needs the built-in provider.");
    if (!Number.isInteger(jobs) || jobs < 2 || jobs > 20) throw new Error("Use 2 to 20 jobs.");
    if (!Number.isInteger(estimate) || estimate < 1 || estimate > 1_000_000 || !Number.isInteger(limit) || limit < 1 || limit > 10_000_000) throw new Error("Use an estimate up to 1,000,000 and a limit up to 10,000,000.");
    const ownerId = `lab_${Math.random().toString(36).slice(2, 10)}`;
    await ctx.runMutation(internal.lab.seed, { ownerId, limit });
    const plan = { actual: estimate, stepTokens: Math.max(1, Math.round(estimate / 8)), stepMs: 60 };
    const answers: Admitted[] = await Promise.all(
      Array.from({ length: jobs }, (_, i) => submitJob(ctx, { ownerId, key: `job-${i + 1}`, label: `Job ${i + 1}`, estimate, mode, plan })),
    );
    // Wait for the admitted jobs to end. The worker runs steps of 60 ms, so this takes a second or two.
    let view: { used: number; running: number } = await ctx.runQuery(internal.lab.view, { ownerId });
    for (let waited = 0; view.running > 0 && waited < 20_000; waited += 250) {
      await sleep(250);
      view = await ctx.runQuery(internal.lab.view, { ownerId });
    }
    return { mode, limit, estimate, jobs, admitted: answers.filter((a) => a.admitted).length, refused: answers.filter((a) => !a.admitted).length, spent: view.used, over: Math.max(0, view.used - limit), running: view.running };
  },
});
