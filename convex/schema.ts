import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const status = v.union(
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("capped"),
  v.literal("expired"),
  v.literal("refused"),
);

export default defineSchema({
  /** Where an account's plan limit comes from, and the last limit that was read. */
  billing: defineTable({
    ownerId: v.string(),
    featureCode: v.string(),
    /** The limit from the plan. With the built-in provider it is set by hand. With Kinde it is read from the customer's entitlements. */
    limit: v.optional(v.number()),
    limitCheckedAt: v.optional(v.number()),
    /** Kinde only: the billing customer and the agreement that usage is reported to. */
    customerId: v.optional(v.string()),
    agreementId: v.optional(v.string()),
    /** The moment the agreement started. Kinde starts each cycle on that day and time. */
    cycleStart: v.optional(v.number()),
    /** How many jobs this account started in the current minute. A counter here keeps the rate check from reading every recent job row. */
    windowStart: v.optional(v.number()),
    windowCount: v.optional(v.number()),
  }).index("by_owner", ["ownerId"]),

  /**
   * One row for each account and cycle: what is spent, and what is promised to running jobs.
   * Every admission reads and writes this one row, so two admissions cannot both be given the same capacity.
   */
  budgets: defineTable({
    ownerId: v.string(),
    cycle: v.string(),
    used: v.number(),
    held: v.number(),
    /** Older versions kept the report state on this row. It now lives in "reports", so that reporting never competes with admission. */
    reported: v.optional(v.number()),
    dirty: v.optional(v.boolean()),
    meter: v.optional(v.number()),
    reportError: v.optional(v.string()),
  }).index("by_owner_cycle", ["ownerId", "cycle"]),

  /**
   * What has been sent to the provider for each account and cycle, and whether a newer total is waiting.
   * It is a separate row so that sending a report never changes the budget row that admission depends on.
   */
  reports: defineTable({
    ownerId: v.string(),
    cycle: v.string(),
    /** The total last sent to the provider. */
    reported: v.optional(v.number()),
    /** True while a newer total is waiting to be sent. */
    dirty: v.boolean(),
    /** The built-in provider's copy of the total. */
    meter: v.optional(v.number()),
    reportError: v.optional(v.string()),
  })
    .index("by_owner_cycle", ["ownerId", "cycle"])
    .index("by_dirty", ["dirty"]),

  jobs: defineTable({
    ownerId: v.string(),
    /** The caller's key for this job. Sending the same key again returns the same job and holds nothing new. */
    key: v.string(),
    label: v.string(),
    cycle: v.string(),
    estimate: v.number(),
    /** What is held for the job while it runs. Zero once the job is settled, and for a refused job. */
    held: v.number(),
    used: v.number(),
    status,
    /** "earmark" holds capacity first. "naive" only checks what is already spent. It exists so the Concurrency Lab can show the difference. */
    mode: v.union(v.literal("earmark"), v.literal("naive")),
    reason: v.optional(v.string()),
    createdAt: v.number(),
    /** The hold lapses if the worker has not charged or renewed it by this time. */
    leaseUntil: v.number(),
    settledAt: v.optional(v.number()),
    /** What the built-in worker does. A real worker would do the work and report what it cost. */
    plan: v.optional(
      v.object({
        actual: v.number(),
        stepTokens: v.number(),
        stepMs: v.number(),
        failAfter: v.optional(v.number()),
        crashAfter: v.optional(v.number()),
      }),
    ),
  })
    .index("by_owner_key", ["ownerId", "key"])
    .index("by_owner_created", ["ownerId", "createdAt"])
    .index("by_status_lease", ["status", "leaseUntil"]),

  /** One row for each job that ended: what it held, what it was charged, and what went back. Rows are added and never edited. */
  settlements: defineTable({
    ownerId: v.string(),
    jobId: v.id("jobs"),
    cycle: v.string(),
    held: v.number(),
    charged: v.number(),
    released: v.number(),
    status: v.string(),
    at: v.number(),
  }).index("by_owner_at", ["ownerId", "at"]),
});
