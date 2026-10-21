import { Dashboard } from "@/components/dashboard";
import { currentOwner } from "@/lib/auth";
import { builtin, convex, serverKey } from "@/lib/convex";
import { api } from "../../../convex/_generated/api";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

export default async function AppPage() {
  const owner = (await currentOwner())!;
  const initial = await convex().query(api.gate.overview, { serverKey: serverKey(), ownerId: owner.id });
  return <Dashboard initial={initial} builtin={builtin()} />;
}
