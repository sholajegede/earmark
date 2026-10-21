import { redirect } from "next/navigation";
import { Footer, Nav } from "@/components/chrome";
import { currentOwner, signInHref } from "@/lib/auth";
import { kindeReady } from "@/lib/kinde";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const owner = await currentOwner();
  if (!owner) {
    if (kindeReady()) redirect(signInHref());
    return (
      <>
        <div className="stage slim">
          <Nav href="/" />
        </div>
        <main id="main" className="app dash">
          <h1>Sign-in is not set up</h1>
          <p className="sub">This server has no Kinde settings. Add them, then open this page again.</p>
        </main>
      </>
    );
  }
  return (
    <>
      <div className="stage slim">
        <Nav signedIn href="/app" />
      </div>
      <main id="main" className="app dash">
        {children}
      </main>
      <div className="app dash-foot">
        {owner.email && <span>{owner.email}</span>}
        {/* A plain link on purpose: a Link would prefetch the log-out route and sign you out. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        {kindeReady() && <a href="/api/auth/logout">Log out</a>}
      </div>
      <Footer />
    </>
  );
}
