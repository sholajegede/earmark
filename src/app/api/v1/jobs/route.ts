import { randomUUID } from "node:crypto";
import { currentOwner } from "@/lib/auth";
import { convex, serverKey } from "@/lib/convex";
import { cleanError } from "@/lib/errors";
import { api } from "../../../../../convex/_generated/api";

interface Simulate {
  actual?: unknown;
  step_tokens?: unknown;
  step_ms?: unknown;
  fail_after?: unknown;
  crash_after?: unknown;
}

const whole = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/**
 * Ask to start a job that is expected to cost `estimate` units.
 * 202 means the whole estimate is held and the job is running. 402 means it did not fit, with the amount left.
 * Send an Idempotency-Key header (or a key field) so that a retry returns the same job and holds nothing twice.
 */
export async function POST(request: Request) {
  const owner = await currentOwner(request);
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { label?: unknown; estimate?: unknown; key?: unknown; simulate?: Simulate };
  const estimate = typeof body.estimate === "number" ? body.estimate : Number(body.estimate);
  if (!Number.isInteger(estimate) || estimate < 1) return Response.json({ error: "Send estimate as a whole number of 1 or more." }, { status: 400 });
  const key = (request.headers.get("idempotency-key") ?? (typeof body.key === "string" ? body.key : "")).trim() || randomUUID();
  if (key.length > 120) return Response.json({ error: "The key is longer than 120 characters." }, { status: 400 });
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : "Job";

  const sim = body.simulate ?? {};
  const actual = whole(sim.actual, estimate, 0, 100_000_000);
  const plan = {
    actual,
    stepTokens: whole(sim.step_tokens, Math.max(1, Math.round(actual / 10)), 1, 100_000_000),
    stepMs: whole(sim.step_ms, 0, 0, 5_000),
    ...(sim.fail_after !== undefined ? { failAfter: whole(sim.fail_after, 0, 0, 100_000_000) } : {}),
    ...(sim.crash_after !== undefined ? { crashAfter: whole(sim.crash_after, 0, 0, 100_000_000) } : {}),
  };

  try {
    const result = await convex().action(api.gate.submit, { serverKey: serverKey(), ownerId: owner.id, key, label, estimate, plan });
    if (!result.admitted) return Response.json({ admitted: false, job_id: result.jobId, key, reason: result.reason, remaining: result.remaining }, { status: 402 });
    return Response.json({ admitted: true, job_id: result.jobId, key, duplicate: result.duplicate, held: estimate, remaining: result.remaining }, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    return Response.json({ error: cleanError(error, "Could not start the job.") }, { status: 400 });
  }
}
