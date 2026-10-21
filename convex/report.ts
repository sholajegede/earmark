import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { CLAIM_BATCH, SEND_PARALLEL } from "./lib/core";
import { providerIsKinde, sendKindeTotal } from "./lib/provider";

interface Claimed {
  ownerId: string;
  cycle: string;
  total: number;
  agreementId: string | null;
  featureCode: string;
}

/**
 * Take the budgets that have a new total waiting. Each one is unmarked here and sent below.
 * If the send fails, the budget is marked again, so a failed report is never forgotten.
 */
export const claim = internalMutation({
  args: {},
  handler: async (ctx): Promise<Claimed[]> => {
    const rows = await ctx.db.query("reports").withIndex("by_dirty", (q) => q.eq("dirty", true)).take(CLAIM_BATCH);
    const out: Claimed[] = [];
    for (const row of rows) {
      await ctx.db.patch(row._id, { dirty: false });
      const billing = await ctx.db.query("billing").withIndex("by_owner", (q) => q.eq("ownerId", row.ownerId)).unique();
      const budget = await ctx.db.query("budgets").withIndex("by_owner_cycle", (q) => q.eq("ownerId", row.ownerId).eq("cycle", row.cycle)).unique();
      out.push({ ownerId: row.ownerId, cycle: row.cycle, total: budget?.used ?? 0, agreementId: billing?.agreementId ?? null, featureCode: billing?.featureCode ?? "tokens" });
    }
    return out;
  },
});

export const sent = internalMutation({
  args: { ownerId: v.string(), cycle: v.string(), total: v.number(), builtin: v.boolean() },
  handler: async (ctx, { ownerId, cycle, total, builtin }) => {
    const row = await ctx.db.query("reports").withIndex("by_owner_cycle", (q) => q.eq("ownerId", ownerId).eq("cycle", cycle)).unique();
    if (row) await ctx.db.patch(row._id, { reported: total, reportError: undefined, ...(builtin ? { meter: total } : {}) });
  },
});

export const failed = internalMutation({
  args: { ownerId: v.string(), cycle: v.string(), error: v.string() },
  handler: async (ctx, { ownerId, cycle, error }) => {
    const row = await ctx.db.query("reports").withIndex("by_owner_cycle", (q) => q.eq("ownerId", ownerId).eq("cycle", cycle)).unique();
    if (row) await ctx.db.patch(row._id, { dirty: true, reportError: error.slice(0, 200) });
  },
});

/**
 * Send each changed total to the provider as an absolute write.
 * Only settled usage is sent. A hold is a promise, not usage, so it never reaches the meter.
 */
export const reportDue = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const rows: Claimed[] = await ctx.runMutation(internal.report.claim, {});
    for (let i = 0; i < rows.length; i += SEND_PARALLEL) {
      await Promise.all(
        rows.slice(i, i + SEND_PARALLEL).map(async (row) => {
          try {
            if (providerIsKinde()) await sendKindeTotal({ agreementId: row.agreementId ?? undefined, featureCode: row.featureCode }, row.total);
            await ctx.runMutation(internal.report.sent, { ownerId: row.ownerId, cycle: row.cycle, total: row.total, builtin: !providerIsKinde() });
          } catch (error) {
            await ctx.runMutation(internal.report.failed, { ownerId: row.ownerId, cycle: row.cycle, error: error instanceof Error ? error.message : "The report failed." });
          }
        }),
      );
    }
    return rows.length;
  },
});
