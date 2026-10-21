import { describe, expect, it } from "vitest";
import { isConflict, retryConflicts } from "../convex/lib/retry";
import {
  admit,
  admitWithoutHold,
  chargeStep,
  chooseLimit,
  cycleOf,
  HOLD_TTL_MS,
  limitFromEntitlements,
  limitIsFresh,
  LIMIT_FRESH_MS,
  LIMIT_STALE_OK_MS,
  MAX_ESTIMATE,
  remainingOf,
  settle,
  UNLIMITED,
  validCycleStart,
} from "../convex/lib/core";

describe("the gate", () => {
  it("lets a job in when its whole hold fits", () => {
    expect(admit({ limit: 100, used: 20, held: 30 }, 50)).toEqual({ admitted: true, remaining: 0 });
  });

  it("counts held capacity, so two jobs cannot be promised the same room", () => {
    const first = admit({ limit: 100_000, used: 0, held: 0 }, 40_000);
    expect(first.admitted).toBe(true);
    // The second job is checked against a budget that now holds the first one's 40,000.
    expect(admit({ limit: 100_000, used: 0, held: 40_000 }, 40_000).admitted).toBe(true);
    expect(admit({ limit: 100_000, used: 0, held: 80_000 }, 40_000)).toMatchObject({ admitted: false, remaining: 20_000 });
  });

  it("says how much is left and why it refused", () => {
    const answer = admit({ limit: 100, used: 90, held: 5 }, 10);
    expect(answer).toMatchObject({ admitted: false, remaining: 5 });
    expect(answer.admitted === false && answer.reason).toContain("5 is left");
  });

  it("never reports a negative amount left", () => {
    expect(remainingOf({ limit: 100, used: 150, held: 10 })).toBe(0);
  });

  it("refuses an estimate that is not a whole number, is zero, or is above the cap", () => {
    for (const bad of [0, -5, 1.5, Number.NaN, MAX_ESTIMATE + 1]) {
      expect(admit({ limit: 1e12, used: 0, held: 0 }, bad).admitted).toBe(false);
    }
  });

  it("shows the bug: a check that ignores held capacity lets every job in", () => {
    // Five jobs of 40,000 against a limit of 100,000. Nothing is spent yet, so each check sees 100,000 left.
    for (let i = 0; i < 5; i++) expect(admitWithoutHold({ limit: 100_000, used: 0, held: 0 }, 40_000).admitted).toBe(true);
  });
});

describe("charging and settling", () => {
  it("charges a step in full while there is room", () => {
    expect(chargeStep(100, 40, 30)).toEqual({ charged: 30, capped: false });
  });

  it("charges only what is left of the hold, then says it was capped", () => {
    expect(chargeStep(100, 90, 30)).toEqual({ charged: 10, capped: true });
    expect(chargeStep(100, 100, 5)).toEqual({ charged: 0, capped: true });
  });

  it("returns the unused part of a hold when a job ends", () => {
    expect(settle(100, 60)).toEqual({ charged: 60, released: 40 });
    expect(settle(100, 100)).toEqual({ charged: 100, released: 0 });
    expect(settle(100, 0)).toEqual({ charged: 0, released: 100 });
  });

  it("never charges more than was held", () => {
    expect(settle(100, 130)).toEqual({ charged: 100, released: 0 });
  });
});

describe("which limit to trust", () => {
  const now = 10_000_000;
  it("uses a fresh read from the provider", () => {
    expect(chooseLimit({ limit: 5, checkedAt: 1 }, { kind: "fresh", limit: 500 }, now)).toEqual({ use: 500, source: "provider" });
  });

  it("falls back to the last known limit for a short time when the provider cannot be read", () => {
    expect(chooseLimit({ limit: 500, checkedAt: now - 60_000 }, { kind: "unreadable" }, now)).toEqual({ use: 500, source: "cached" });
    expect(chooseLimit({ limit: 500, checkedAt: now - LIMIT_STALE_OK_MS }, { kind: "unreadable" }, now)).toMatchObject({ use: 500 });
  });

  it("refuses new work when the last known limit is too old, or there is none", () => {
    expect(chooseLimit({ limit: 500, checkedAt: now - LIMIT_STALE_OK_MS - 1 }, { kind: "unreadable" }, now)).toMatchObject({ use: null, source: "unknown" });
    expect(chooseLimit({ limit: null, checkedAt: null }, { kind: "unreadable" }, now)).toMatchObject({ use: null });
  });

  it("knows when a stored limit is fresh enough to skip the provider", () => {
    expect(limitIsFresh({ limit: 5, checkedAt: now - LIMIT_FRESH_MS }, now)).toBe(true);
    expect(limitIsFresh({ limit: 5, checkedAt: now - LIMIT_FRESH_MS - 1 }, now)).toBe(false);
    expect(limitIsFresh({ limit: null, checkedAt: null }, now)).toBe(false);
  });

  it("keeps the hold lease longer than the worker's step, so a live worker is not cut off", () => {
    expect(HOLD_TTL_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe("reading Kinde's entitlements", () => {
  const body = (entitlements: unknown[]) => ({ code: "OK", entitlements });
  it("finds the maximum for the feature", () => {
    expect(limitFromEntitlements(body([{ feature_code: "other", entitlement_limit_max: 5 }, { feature_code: "tokens", entitlement_limit_max: 100_000 }]), "tokens")).toBe(100_000);
  });

  it("accepts the account API's feature_key and a wrapped body", () => {
    expect(limitFromEntitlements({ data: { entitlements: [{ feature_key: "tokens", entitlement_limit_max: 7 }] } }, "tokens")).toBe(7);
  });

  it("treats a null maximum as no limit", () => {
    expect(limitFromEntitlements(body([{ feature_code: "tokens", entitlement_limit_max: null }]), "tokens")).toBe(UNLIMITED);
  });

  it("takes the largest maximum when two plans grant the feature", () => {
    expect(limitFromEntitlements(body([{ feature_code: "tokens", entitlement_limit_max: 10 }, { feature_code: "tokens", entitlement_limit_max: 50 }]), "tokens")).toBe(50);
  });

  it("returns null when the feature is missing or the body is not an entitlements answer", () => {
    expect(limitFromEntitlements(body([]), "tokens")).toBeNull();
    expect(limitFromEntitlements(null, "tokens")).toBeNull();
    expect(limitFromEntitlements({ entitlements: "nope" }, "tokens")).toBeNull();
    expect(limitFromEntitlements(body([{ feature_code: "tokens", entitlement_limit_max: -1 }]), "tokens")).toBeNull();
  });
});

describe("billing cycles", () => {
  it("is a calendar month in UTC with no anchor, and follows the agreement start with one", () => {
    expect(cycleOf(Date.UTC(2026, 9, 31, 23, 59))).toBe("2026-10");
    const anchor = Date.UTC(2026, 9, 20, 15, 29);
    expect(cycleOf(Date.UTC(2026, 10, 19, 12, 0), anchor)).toBe("2026-10");
    expect(cycleOf(Date.UTC(2026, 10, 21, 12, 0), anchor)).toBe("2026-11");
    expect(validCycleStart(Date.UTC(2026, 9, 29))).toBe(false);
  });
});

describe("retrying conflicts", () => {
  const conflict = () => new Error('Documents read from or written to the table "budgets" changed while this mutation was being run and on every subsequent retry.');
  it("tries again after a conflict and returns the answer", async () => {
    let calls = 0;
    const answer = await retryConflicts(async () => {
      if (++calls < 3) throw conflict();
      return "ok";
    }, 6, async () => {});
    expect(answer).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after the last try, and never retries other errors", async () => {
    let calls = 0;
    await expect(retryConflicts(async () => { calls++; throw conflict(); }, 3, async () => {})).rejects.toThrow("changed while");
    expect(calls).toBe(3);
    let other = 0;
    await expect(retryConflicts(async () => { other++; throw new Error("Not allowed."); }, 3, async () => {})).rejects.toThrow("Not allowed");
    expect(other).toBe(1);
    expect(isConflict("text")).toBe(false);
  });
});
