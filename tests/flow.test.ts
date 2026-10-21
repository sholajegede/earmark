import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { cycleOf, DEFAULT_LIMIT, HOLD_TTL_MS, JOBS_PER_MINUTE } from "../convex/lib/core";

const modules = import.meta.glob("../convex/**/*.ts");
const serverKey = "test-key";
const ownerId = "kp_owner";

let current: ReturnType<typeof convexTest> | undefined;
const start = () => (current = convexTest(schema, modules));
type T = ReturnType<typeof start>;

beforeEach(() => {
  process.env.EARMARK_SERVER_KEY = serverKey;
  delete process.env.PROVIDER;
  vi.useFakeTimers();
});
afterEach(async () => {
  if (vi.isFakeTimers()) await current?.finishAllScheduledFunctions(vi.runAllTimers);
  else await current?.finishInProgressScheduledFunctions();
  current = undefined;
  vi.useRealTimers();
});

const plan = (actual: number, extra: { failAfter?: number; crashAfter?: number } = {}) => ({ actual, stepTokens: Math.max(1, Math.round(actual / 4)), stepMs: 0, ...extra });
const submit = (t: T, key: string, estimate: number, p?: ReturnType<typeof plan>, mode?: "earmark" | "naive", owner = ownerId) =>
  t.action(api.gate.submit, { serverKey, ownerId: owner, key, label: key, estimate, plan: p, mode });
const view = (t: T, owner = ownerId) => t.query(api.gate.overview, { serverKey, ownerId: owner });
const settleAll = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const job = async (t: T, id: Id<"jobs">) => (await t.run(async (ctx) => ctx.db.get(id)))!;

describe("admission", () => {
  it("holds the estimate and leaves the rest", async () => {
    const t = start();
    const a = await submit(t, "a", 30_000, plan(30_000, { crashAfter: 0 }));
    expect(a).toMatchObject({ admitted: true, duplicate: false, remaining: DEFAULT_LIMIT - 30_000 });
    const v = await view(t);
    expect(v.budget).toMatchObject({ used: 0, held: 30_000, remaining: 70_000, limit: DEFAULT_LIMIT });
  });

  it("refuses a job that does not fit, tells how much is left, and holds nothing", async () => {
    const t = start();
    await submit(t, "big", 90_000, plan(90_000, { crashAfter: 0 }));
    const b = await submit(t, "too-much", 20_000);
    expect(b).toMatchObject({ admitted: false, remaining: 10_000 });
    expect(b.reason).toContain("10,000 is left");
    expect((await view(t)).budget).toMatchObject({ held: 90_000, used: 0 });
    expect((await job(t, b.jobId)).status).toBe("refused");
  });

  it("gives five concurrent jobs of 40,000 a limit of 100,000: two get in, three are refused, held never passes the limit", async () => {
    const t = start();
    const answers = await Promise.all(Array.from({ length: 5 }, (_, i) => submit(t, `j${i}`, 40_000, plan(40_000))));
    expect(answers.filter((a) => a.admitted)).toHaveLength(2);
    expect(answers.filter((a) => !a.admitted)).toHaveLength(3);
    await settleAll(t);
    const v = await view(t);
    expect(v.budget).toMatchObject({ used: 80_000, held: 0 });
    expect(v.budget.used).toBeLessThanOrEqual(DEFAULT_LIMIT);
  });

  it("shows the bug without a hold: the same five jobs all get in and spend 200,000 of 100,000", async () => {
    const t = start();
    const answers = await Promise.all(Array.from({ length: 5 }, (_, i) => submit(t, `j${i}`, 40_000, plan(40_000), "naive")));
    expect(answers.every((a) => a.admitted)).toBe(true);
    await settleAll(t);
    expect((await view(t)).budget.used).toBe(200_000);
  });

  it("returns the same job for the same key and holds nothing twice", async () => {
    const t = start();
    const first = await submit(t, "same", 10_000, plan(10_000, { crashAfter: 0 }));
    const second = await submit(t, "same", 10_000);
    expect(second).toMatchObject({ jobId: first.jobId, duplicate: true, admitted: true });
    expect((await view(t)).budget.held).toBe(10_000);
    expect((await view(t)).jobs).toHaveLength(1);
  });

  it("keeps accounts apart", async () => {
    const t = start();
    await submit(t, "a", 90_000, plan(90_000, { crashAfter: 0 }), undefined, "kp_one");
    expect((await submit(t, "b", 90_000, plan(90_000), undefined, "kp_two")).admitted).toBe(true);
  });

  it("refuses calls without the server key and a bad estimate", async () => {
    const t = start();
    await expect(t.action(api.gate.submit, { serverKey: "wrong", ownerId, key: "x", label: "x", estimate: 5 })).rejects.toThrow("Not allowed");
    expect(await submit(t, "zero", 0)).toMatchObject({ admitted: false });
  });

  it("slows a script that starts too many jobs in a minute", async () => {
    const t = start();
    for (let i = 0; i < JOBS_PER_MINUTE; i++) expect((await submit(t, `fast${i}`, 1)).admitted).toBe(true);
    await expect(submit(t, "one-more", 1)).rejects.toThrow("Slow down");
  });

  it("lets the counter start again after a minute", async () => {
    const t = start();
    await t.run(async (ctx) => {
      await ctx.db.insert("billing", { ownerId, featureCode: "tokens", limit: 100_000, windowStart: Date.now() - 61_000, windowCount: JOBS_PER_MINUTE });
    });
    expect((await submit(t, "after-a-minute", 1)).admitted).toBe(true);
  });
});

describe("settling", () => {
  it("charges the actual cost and returns the rest of the hold", async () => {
    const t = start();
    const a = await submit(t, "a", 10_000, plan(6_000));
    await settleAll(t);
    expect(await job(t, a.jobId)).toMatchObject({ status: "succeeded", used: 6_000, held: 0 });
    const v = await view(t);
    expect(v.budget).toMatchObject({ used: 6_000, held: 0, remaining: DEFAULT_LIMIT - 6_000 });
    expect(v.settlements[0]).toMatchObject({ held: 10_000, charged: 6_000, released: 4_000 });
  });

  it("stops a job at its hold when the work costs more than the estimate", async () => {
    const t = start();
    const a = await submit(t, "a", 10_000, plan(15_000));
    await settleAll(t);
    expect(await job(t, a.jobId)).toMatchObject({ status: "capped", used: 10_000 });
    expect((await view(t)).budget).toMatchObject({ used: 10_000, held: 0 });
  });

  it("charges a failed job for the work it did", async () => {
    const t = start();
    const a = await submit(t, "a", 20_000, plan(20_000, { failAfter: 10_000 }));
    await settleAll(t);
    const j = await job(t, a.jobId);
    expect(j.status).toBe("failed");
    expect(j.used).toBeGreaterThanOrEqual(10_000);
    expect(j.used).toBeLessThan(20_000);
    expect((await view(t)).budget).toMatchObject({ used: j.used, held: 0 });
  });

  it("settles once: a second finish charges nothing more", async () => {
    const t = start();
    const a = await submit(t, "a", 10_000, plan(10_000));
    await settleAll(t);
    const again = await t.mutation(internal.gate.finish, { jobId: a.jobId, status: "failed" });
    expect(again).toBeNull();
    expect((await view(t)).budget.used).toBe(10_000);
    expect((await view(t)).settlements).toHaveLength(1);
  });

  it("frees capacity for the next job as soon as one ends", async () => {
    const t = start();
    await submit(t, "a", 60_000, plan(60_000));
    expect((await submit(t, "b", 60_000)).admitted).toBe(false);
    await settleAll(t);
    // 60,000 is spent for good, so 40,000 is left and a 30,000 job fits.
    expect((await submit(t, "c", 30_000, plan(30_000))).admitted).toBe(true);
  });
});

describe("a worker that stops", () => {
  it("is settled at what it used when its hold runs out, and the capacity comes back", async () => {
    const t = start();
    const a = await submit(t, "a", 50_000, plan(50_000, { crashAfter: 20_000 }));
    await settleAll(t);
    expect((await job(t, a.jobId)).status).toBe("running");
    expect((await view(t)).budget.held).toBe(50_000);

    vi.setSystemTime(Date.now() + HOLD_TTL_MS + 1_000);
    expect(await t.mutation(internal.gate.expire, {})).toBe(1);
    const j = await job(t, a.jobId);
    expect(j.status).toBe("expired");
    expect(j.used).toBeGreaterThanOrEqual(20_000);
    const v = await view(t);
    expect(v.budget.held).toBe(0);
    expect(v.budget.used).toBe(j.used);
  });

  it("does not touch a job whose worker is still alive", async () => {
    const t = start();
    await submit(t, "a", 10_000, plan(10_000, { crashAfter: 0 }));
    vi.setSystemTime(Date.now() + HOLD_TTL_MS - 5_000);
    expect(await t.mutation(internal.gate.expire, {})).toBe(0);
  });

  it("cannot spend after its hold was settled", async () => {
    const t = start();
    const a = await submit(t, "a", 10_000, plan(10_000, { crashAfter: 0 }));
    vi.setSystemTime(Date.now() + HOLD_TTL_MS + 1_000);
    await t.mutation(internal.gate.expire, {});
    expect(await t.mutation(internal.gate.spend, { jobId: a.jobId, tokens: 500 })).toMatchObject({ charged: 0, live: false });
    expect((await view(t)).budget.used).toBe(0);
  });
});

describe("the plan limit", () => {
  it("lets in more work after an upgrade, and refuses new work after a downgrade without stopping a running job", async () => {
    const t = start();
    await submit(t, "a", 90_000, plan(90_000, { crashAfter: 0 }));
    expect((await submit(t, "b", 50_000)).admitted).toBe(false);
    await t.mutation(api.gate.setLimit, { serverKey, ownerId, limit: 200_000 });
    expect((await submit(t, "c", 50_000, plan(50_000, { crashAfter: 0 }))).admitted).toBe(true);
    await t.mutation(api.gate.setLimit, { serverKey, ownerId, limit: 100_000 });
    expect((await submit(t, "d", 1_000)).admitted).toBe(false);
    expect((await view(t)).budget.held).toBe(140_000); // the running jobs keep their holds
  });

  it("only changes by hand with the built-in provider", async () => {
    const t = start();
    process.env.PROVIDER = "kinde";
    await expect(t.mutation(api.gate.setLimit, { serverKey, ownerId, limit: 5 })).rejects.toThrow("Change the plan in Kinde");
  });

  it("refuses new work when the provider's limit cannot be read and none is known", async () => {
    const t = start();
    process.env.PROVIDER = "kinde";
    await t.mutation(api.gate.connect, { serverKey, ownerId, customerId: "cus_1", agreementId: "agr_1", featureCode: "tokens" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const a = await submit(t, "a", 10);
    expect(a).toMatchObject({ admitted: false });
    expect(a.reason).toContain("could not be read");
    vi.unstubAllGlobals();
  });

  it("reads the limit from Kinde, uses it, and keeps the last one when Kinde goes down", async () => {
    const t = start();
    process.env.PROVIDER = "kinde";
    process.env.KINDE_DOMAIN = "https://example.kinde.com";
    process.env.KINDE_M2M_CLIENT_ID = "id";
    process.env.KINDE_M2M_CLIENT_SECRET = "secret";
    await t.mutation(api.gate.connect, { serverKey, ownerId, customerId: "cus_1", agreementId: "agr_1", featureCode: "tokens" });
    let up = true;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 3600 });
      if (!up) return new Response("down", { status: 503 });
      return Response.json({ entitlements: [{ feature_code: "tokens", entitlement_limit_max: 1_000 }] });
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await submit(t, "a", 600, plan(600, { crashAfter: 0 }))).admitted).toBe(true);
    expect((await view(t)).billing.limit).toBe(1_000);
    // Within a minute the stored limit is used without asking Kinde again.
    const calls = fetcher.mock.calls.length;
    expect((await submit(t, "b", 300, plan(300, { crashAfter: 0 }))).admitted).toBe(true);
    expect(fetcher.mock.calls.length).toBe(calls);
    // A minute later Kinde is down. The last limit still holds for a while, so a job that does not fit is refused, not allowed through.
    up = false;
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect(await submit(t, "c", 200)).toMatchObject({ admitted: false });
    expect((await submit(t, "d", 100, plan(100, { crashAfter: 0 }))).admitted).toBe(true);
    // Ten minutes later with Kinde still down, new work is refused even though it would fit.
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await submit(t, "e", 1)).toMatchObject({ admitted: false });
    vi.unstubAllGlobals();
  });
});

describe("cycles", () => {
  it("settles a job in the cycle it was admitted in, even if the month changed while it ran", async () => {
    const t = start();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 31, 23, 59, 0)));
    const a = await submit(t, "a", 10_000, plan(10_000, { crashAfter: 4_000 }));
    await settleAll(t);
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, 0, 5, 0)));
    await t.mutation(internal.gate.expire, {});
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, 0, 6, 0)));
    expect((await job(t, a.jobId)).cycle).toBe("2026-10");
    const october = await t.run(async (ctx) => ctx.db.query("budgets").collect());
    expect(october.find((b) => b.cycle === "2026-10")?.held).toBe(0);
    expect(cycleOf(Date.now())).toBe("2026-11");
    expect((await view(t)).budget).toMatchObject({ cycle: "2026-11", used: 0, held: 0 });
  });
});

describe("reporting usage", () => {
  it("sends only settled usage, never a hold, and sends each change once", async () => {
    const t = start();
    await submit(t, "a", 10_000, plan(10_000, { crashAfter: 0 }));
    expect(await t.action(internal.report.reportDue, {})).toBe(0); // a hold alone changes nothing to report
    await submit(t, "b", 5_000, plan(5_000));
    await settleAll(t);
    expect(await t.action(internal.report.reportDue, {})).toBe(1);
    expect((await view(t)).budget).toMatchObject({ meter: 5_000, reported: 5_000, dirty: false });
    expect(await t.action(internal.report.reportDue, {})).toBe(0);
  });

  it("marks the total again when a report fails, and sends the newest total next time", async () => {
    const t = start();
    process.env.PROVIDER = "kinde";
    process.env.KINDE_DOMAIN = "https://example.kinde.com";
    await t.mutation(api.gate.connect, { serverKey, ownerId, customerId: "cus_1", agreementId: "agr_1", featureCode: "tokens" });
    await t.mutation(internal.gate.storeLimit, { ownerId, limit: 100_000 });
    await submit(t, "a", 4_000, plan(4_000));
    await settleAll(t);
    const bodies: string[] = [];
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 3600 });
        if (fail) return new Response("slow down", { status: 429 });
        bodies.push(String(init?.body));
        return Response.json({ code: "OK" });
      }),
    );
    await t.action(internal.report.reportDue, {});
    expect((await view(t)).budget).toMatchObject({ dirty: true, reported: null });
    fail = false;
    await t.action(internal.report.reportDue, {});
    expect(JSON.parse(bodies[0])).toMatchObject({ customer_agreement_id: "agr_1", billing_feature_code: "tokens", meter_value: "4000", meter_type_code: "absolute" });
    expect((await view(t)).budget).toMatchObject({ dirty: false, reported: 4_000 });
    vi.unstubAllGlobals();
  });
});

describe("the lab", () => {
  // The lab waits for its jobs with real timers: each job takes about half a second of steps.
  beforeEach(() => vi.useRealTimers());

  it("shows the overspend without a hold and none with one", async () => {
    const t = start();
    const safe = await t.action(api.lab.race, { serverKey, mode: "earmark" });
    expect(safe).toMatchObject({ mode: "earmark", admitted: 2, refused: 3, spent: 80_000, over: 0 });
    const unsafe = await t.action(api.lab.race, { serverKey, mode: "naive" });
    expect(unsafe).toMatchObject({ mode: "naive", admitted: 5, refused: 0, spent: 200_000, over: 100_000 });
  }, 30_000);

  it("refuses odd sizes and the unsafe mode with Kinde", async () => {
    const t = start();
    await expect(t.action(api.lab.race, { serverKey, mode: "earmark", jobs: 1 })).rejects.toThrow("Use 2 to 20 jobs");
    process.env.PROVIDER = "kinde";
    await expect(t.action(api.lab.race, { serverKey, mode: "naive" })).rejects.toThrow("built-in provider");
  });
});
