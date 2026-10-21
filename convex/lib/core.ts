/**
 * The rules of Earmark that need no database. Everything here is a pure function,
 * so the same input always gives the same answer and tests can check each rule alone.
 */

/** The billing feature that the limit and the usage belong to. It matches the feature code in Kinde. */
export const FEATURE = "tokens";

/** How long a hold lives without a sign of life from the worker. Every charge from the worker renews it. */
export const HOLD_TTL_MS = 2 * 60_000;
/** A limit read from the provider is used as it is for this long. */
export const LIMIT_FRESH_MS = 60_000;
/** If the provider cannot be read, the last limit it gave is used for this long. After that, new work is refused. */
export const LIMIT_STALE_OK_MS = 10 * 60_000;
/** The most one job can ask to hold. A mistake in an estimate cannot lock a whole account. */
export const MAX_ESTIMATE = 10_000_000;
/** The limit that stands in for "no maximum" when the provider has none. */
export const UNLIMITED = 1_000_000_000_000;
/** A new account with the built-in provider starts with this limit. */
export const DEFAULT_LIMIT = 100_000;

/** The billing cycle a moment belongs to, named by the month it starts in. With an anchor, a cycle starts on the anchor's day and time of the month. */
export const cycleOf = (ms: number, anchor?: number | null): string => {
  const at = new Date(ms);
  let year = at.getUTCFullYear();
  let month = at.getUTCMonth();
  if (anchor !== undefined && anchor !== null) {
    const a = new Date(anchor);
    const start = Date.UTC(year, month, a.getUTCDate(), a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds(), a.getUTCMilliseconds());
    if (ms < start) {
      month -= 1;
      if (month < 0) {
        month = 11;
        year -= 1;
      }
    }
  }
  return `${year}-${String(month + 1).padStart(2, "0")}`;
};

/** A start on the 29th to the 31st has no clear meaning in a short month. */
export const MAX_START_DAY = 28;
export const validCycleStart = (ms: number): boolean => Number.isFinite(ms) && new Date(ms).getUTCDate() <= MAX_START_DAY;

export interface Budget {
  /** What the plan allows in this cycle. */
  limit: number;
  /** Usage that is final: work that has finished and been charged. */
  used: number;
  /** Capacity that is promised to jobs that are still running. */
  held: number;
}

export type Admission =
  | { admitted: true; remaining: number }
  | { admitted: false; remaining: number; reason: string };

/** What is left to promise: the limit minus what is spent and what is already held. Never below zero. */
export const remainingOf = (b: Budget): number => Math.max(0, b.limit - b.used - b.held);

/**
 * The gate. A job is let in only if its whole hold fits in what is left.
 * Used and held are both counted, so two jobs cannot both be promised the same capacity.
 */
export function admit(b: Budget, amount: number): Admission {
  const remaining = remainingOf(b);
  if (!Number.isInteger(amount) || amount < 1) return { admitted: false, remaining, reason: "The estimate must be a whole number of 1 or more." };
  if (amount > MAX_ESTIMATE) return { admitted: false, remaining, reason: `The estimate is above the most one job can hold (${MAX_ESTIMATE.toLocaleString("en-US")}).` };
  if (amount > remaining) {
    return {
      admitted: false,
      remaining,
      reason: `The job needs ${amount.toLocaleString("en-US")} and ${remaining.toLocaleString("en-US")} is left (${b.used.toLocaleString("en-US")} used, ${b.held.toLocaleString("en-US")} held, limit ${b.limit.toLocaleString("en-US")}).`,
    };
  }
  return { admitted: true, remaining: remaining - amount };
}

/** The same check with no hold: the bug that Earmark exists to prevent. It looks only at what is already spent. */
export function admitWithoutHold(b: Budget, amount: number): Admission {
  const remaining = Math.max(0, b.limit - b.used);
  if (!Number.isInteger(amount) || amount < 1) return { admitted: false, remaining, reason: "The estimate must be a whole number of 1 or more." };
  if (amount > remaining) return { admitted: false, remaining, reason: `The job needs ${amount} and ${remaining} is left.` };
  return { admitted: true, remaining: remaining - amount };
}

/** How much a job may still spend, and how much it was charged for a step. A job can never spend past its hold. */
export function chargeStep(held: number, used: number, tokens: number): { charged: number; capped: boolean } {
  const room = Math.max(0, held - used);
  const charged = Math.max(0, Math.min(Math.floor(tokens), room));
  return { charged, capped: charged < tokens };
}

/** When a job ends, it pays for what it used and the rest of its hold goes back. */
export function settle(held: number, used: number): { charged: number; released: number } {
  const charged = Math.min(used, held);
  return { charged, released: held - charged };
}

export type LimitRead = { kind: "fresh"; limit: number } | { kind: "unreadable" };

export interface LimitState {
  limit: number | null;
  checkedAt: number | null;
}

export type LimitDecision =
  | { use: number; source: "provider" | "cached" }
  | { use: null; source: "unknown"; reason: string };

/**
 * Which limit to use for a new job.
 * A fresh limit from the provider wins. If the provider cannot be read, the last known limit is used for a short time.
 * After that the answer is "unknown", and expensive work is refused: it is safer to refuse than to spend past a limit that may have changed.
 */
export function chooseLimit(state: LimitState, read: LimitRead, now: number): LimitDecision {
  if (read.kind === "fresh") return { use: read.limit, source: "provider" };
  if (state.limit !== null && state.checkedAt !== null && now - state.checkedAt <= LIMIT_STALE_OK_MS) return { use: state.limit, source: "cached" };
  return { use: null, source: "unknown", reason: "The plan limit could not be read from the provider, so new work is refused until it can." };
}

/** True when the stored limit is recent enough to use without asking the provider again. */
export const limitIsFresh = (state: LimitState, now: number): boolean =>
  state.limit !== null && state.checkedAt !== null && now - state.checkedAt <= LIMIT_FRESH_MS;

/**
 * Find a feature's maximum in Kinde's entitlements answer.
 * A null maximum means the plan sets none. Kinde returns the max_value we ask for in its place, which is treated as no limit.
 */
export function limitFromEntitlements(body: unknown, featureCode: string): number | null {
  if (body === null || typeof body !== "object") return null;
  const list = (body as { entitlements?: unknown; data?: { entitlements?: unknown } }).entitlements ?? (body as { data?: { entitlements?: unknown } }).data?.entitlements;
  if (!Array.isArray(list)) return null;
  let best: number | null = null;
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (e.feature_code !== featureCode && e.feature_key !== featureCode) continue;
    const raw = e.entitlement_limit_max;
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw === null ? UNLIMITED : NaN;
    if (!Number.isFinite(value) || value < 0) continue;
    // A customer can hold the same feature from more than one plan. Take the largest maximum.
    best = best === null ? value : Math.max(best, value);
  }
  return best;
}

/** Jobs a person can start in one minute. A runaway script cannot fill the table. */
export const JOBS_PER_MINUTE = 120;

/** Budgets sent to the provider in one batch, and how many are sent at the same time. */
export const CLAIM_BATCH = 100;
export const SEND_PARALLEL = 10;
