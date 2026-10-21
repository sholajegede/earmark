import { currentOwner } from "@/lib/auth";
import { convex, serverKey } from "@/lib/convex";
import { cleanError } from "@/lib/errors";
import { api } from "../../../../../convex/_generated/api";

/** Built-in provider: change the plan limit by hand, the way a plan change in Kinde would. */
export async function PATCH(request: Request) {
  const owner = await currentOwner(request);
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { limit?: unknown };
  const limit = typeof body.limit === "number" ? body.limit : Number(body.limit);
  try {
    return Response.json(await convex().mutation(api.gate.setLimit, { serverKey: serverKey(), ownerId: owner.id, limit }));
  } catch (error) {
    return Response.json({ error: cleanError(error, "Could not change the limit.") }, { status: 400 });
  }
}

/**
 * Kinde: say which billing customer's plan sets the limit and which agreement the usage is reported to.
 * cycle_start is the moment the agreement started (an ISO date and time). Kinde starts each billing cycle on that day and time.
 */
export async function POST(request: Request) {
  const owner = await currentOwner(request);
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { customer_id?: unknown; agreement_id?: unknown; feature_code?: unknown; cycle_start?: unknown };
  if (typeof body.customer_id !== "string" || !body.customer_id.trim() || typeof body.agreement_id !== "string" || !body.agreement_id.trim()) {
    return Response.json({ error: "Send the Kinde billing customer id as customer_id and the agreement id as agreement_id." }, { status: 400 });
  }
  const featureCode = typeof body.feature_code === "string" && body.feature_code.trim() ? body.feature_code.trim() : "tokens";
  let cycleStart: number | undefined;
  if (typeof body.cycle_start === "string" && body.cycle_start.trim()) {
    cycleStart = Date.parse(body.cycle_start.trim());
    if (Number.isNaN(cycleStart)) return Response.json({ error: "Send the agreement start as a date and time, for example 2026-10-20T15:29:00Z." }, { status: 400 });
  }
  try {
    await convex().mutation(api.gate.connect, { serverKey: serverKey(), ownerId: owner.id, customerId: body.customer_id.trim(), agreementId: body.agreement_id.trim(), featureCode, cycleStart });
    return Response.json({ connected: true, feature_code: featureCode });
  } catch (error) {
    return Response.json({ error: cleanError(error, "Could not save the billing settings.") }, { status: 400 });
  }
}
