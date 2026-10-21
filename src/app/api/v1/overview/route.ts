import { currentOwner } from "@/lib/auth";
import { convex, serverKey } from "@/lib/convex";
import { api } from "../../../../../convex/_generated/api";

/** The limit, what is spent and held in this cycle, and the latest jobs. */
export async function GET(request: Request) {
  const owner = await currentOwner(request);
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  const view = await convex().query(api.gate.overview, { serverKey: serverKey(), ownerId: owner.id });
  return Response.json(view, { headers: { "cache-control": "no-store" } });
}
