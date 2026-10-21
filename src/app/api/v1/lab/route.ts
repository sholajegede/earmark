import { currentOwner } from "@/lib/auth";
import { convex, serverKey } from "@/lib/convex";
import { cleanError } from "@/lib/errors";
import { api } from "../../../../../convex/_generated/api";

/**
 * The Concurrency Lab. Starts several jobs at the same moment on a scratch account and reports what was spent.
 * mode "naive" checks only what is already spent. mode "earmark" holds capacity first.
 */
export async function POST(request: Request) {
  const owner = await currentOwner(request);
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { mode?: unknown };
  if (body.mode !== "naive" && body.mode !== "earmark") return Response.json({ error: 'Send mode as "naive" or "earmark".' }, { status: 400 });
  try {
    return Response.json(await convex().action(api.lab.race, { serverKey: serverKey(), mode: body.mode }));
  } catch (error) {
    return Response.json({ error: cleanError(error, "The lab could not run.") }, { status: 400 });
  }
}
