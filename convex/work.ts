import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { retryConflicts } from "./lib/retry";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The built-in worker. It stands in for the expensive work (a model call, a render, a long export).
 * It spends tokens in steps. Each step is charged against the job's hold before the next one starts,
 * so the hold is both the promise to the job and the most it can spend.
 *
 * A real worker follows the same shape: charge as the work goes, and stop when a charge says the hold is used up.
 * Two options let you break it on purpose: failAfter stops it with an error, and crashAfter makes it vanish without a word.
 */
export const run = internalAction({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.runQuery(internal.gate.getJob, { jobId });
    if (!job || job.status !== "running") return;
    const plan = job.plan ?? { actual: job.estimate, stepTokens: Math.max(1, Math.round(job.estimate / 10)), stepMs: 0 };
    let done = 0;
    while (done < plan.actual) {
      if (plan.crashAfter !== undefined && done >= plan.crashAfter) return; // the worker is gone: no finish call, the hold lapses on its own
      if (plan.failAfter !== undefined && done >= plan.failAfter) {
        await retryConflicts(() => ctx.runMutation(internal.gate.finish, { jobId, status: "failed", reason: `The work failed after ${done.toLocaleString("en-US")} tokens. The job was charged for them.` }));
        return;
      }
      if (plan.stepMs > 0) await sleep(plan.stepMs);
      const tokens = Math.min(plan.stepTokens, plan.actual - done);
      const step = await ctx.runMutation(internal.gate.spend, { jobId, tokens });
      if (!step.live) return; // the job was settled while the worker was away
      if (step.capped) {
        await retryConflicts(() => ctx.runMutation(internal.gate.finish, { jobId, status: "capped", reason: "The job reached the most it was allowed to spend, and was stopped." }));
        return;
      }
      done += tokens;
    }
    await retryConflicts(() => ctx.runMutation(internal.gate.finish, { jobId, status: "succeeded" }));
  },
});
