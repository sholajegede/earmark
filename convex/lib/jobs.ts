import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { settle } from "./core";

export type Ender = "succeeded" | "failed" | "capped" | "expired";

/** The budget row of an account and cycle. A job always settles in the cycle it was admitted in. */
export async function budgetFor(ctx: Pick<MutationCtx, "db">, ownerId: string, cycle: string): Promise<Doc<"budgets">> {
  const found = await ctx.db.query("budgets").withIndex("by_owner_cycle", (q) => q.eq("ownerId", ownerId).eq("cycle", cycle)).unique();
  if (found) return found;
  const id = await ctx.db.insert("budgets", { ownerId, cycle, used: 0, held: 0 });
  return (await ctx.db.get(id))!;
}

/** Say that a newer total is waiting to be sent. This is a separate row, so it never blocks admission. */
export async function markReport(ctx: Pick<MutationCtx, "db">, ownerId: string, cycle: string): Promise<void> {
  const row = await ctx.db.query("reports").withIndex("by_owner_cycle", (q) => q.eq("ownerId", ownerId).eq("cycle", cycle)).unique();
  if (!row) await ctx.db.insert("reports", { ownerId, cycle, dirty: true });
  else if (!row.dirty) await ctx.db.patch(row._id, { dirty: true });
}

/**
 * End a job. It pays for what it used, and the rest of its hold goes back to the budget.
 * Calling this a second time does nothing, so a late or repeated finish cannot charge twice.
 */
export async function settleJob(ctx: Pick<MutationCtx, "db">, job: Doc<"jobs">, status: Ender, reason?: string): Promise<{ charged: number; released: number } | null> {
  if (job.status !== "running") return null;
  const budget = await budgetFor(ctx, job.ownerId, job.cycle);
  const now = Date.now();
  // A job without a hold (the naive mode) pays for everything it used. A held job can never have used more than it held.
  const { charged, released } = job.mode === "naive" ? { charged: job.used, released: 0 } : settle(job.held, job.used);
  await ctx.db.patch(budget._id, {
    held: Math.max(0, budget.held - job.held),
    used: budget.used + charged,
  });
  // A new total is waiting for the provider only if the spent amount changed.
  if (charged > 0) await markReport(ctx, job.ownerId, job.cycle);
  await ctx.db.patch(job._id, { status, held: 0, settledAt: now, ...(reason ? { reason } : {}) });
  await ctx.db.insert("settlements", { ownerId: job.ownerId, jobId: job._id, cycle: job.cycle, held: job.held, charged, released, status, at: now });
  return { charged, released };
}
