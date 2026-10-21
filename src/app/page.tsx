import Link from "next/link";
import { Arrow, Footer, Nav } from "@/components/chrome";
import { site } from "@/lib/site";
import { currentOwner, signInHref } from "@/lib/auth";
import { kindeReady } from "@/lib/kinde";

export const dynamic = "force-dynamic";

const curl = `curl -X POST $SITE/api/v1/jobs \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Idempotency-Key: report-2026-10-21" \\
  -H "content-type: application/json" \\
  -d '{"label":"Summarize 40 PDFs","estimate":40000}'

# 202  {"admitted":true,"held":40000,"remaining":60000}
# 402  {"admitted":false,"reason":"The job needs 40,000 and 20,000 is left (...)","remaining":20000}`;

const star = Array.from({ length: 56 }, (_, i) => {
  const angle = (Math.PI * 2 * i) / 56;
  const radius = i % 2 === 0 ? 200 - (i % 6 === 0 ? 0 : 38 + ((i * 7) % 5) * 10) : 52;
  return `${(200 + Math.cos(angle) * radius).toFixed(1)},${(200 + Math.sin(angle) * radius).toFixed(1)}`;
}).join(" ");

const feed: { tone: "a" | "r" | "s"; tag: string; text: string }[] = [
  { tone: "a", tag: "202", text: "40,000 held, 60,000 left" },
  { tone: "r", tag: "402", text: "needs 40,000, 20,000 left" },
  { tone: "s", tag: "settled", text: "charged 31,200, returned 8,800" },
  { tone: "a", tag: "202", text: "40,000 held, 20,000 left" },
  { tone: "r", tag: "capped", text: "job stopped at its 40,000 hold" },
  { tone: "s", tag: "expired", text: "worker stopped, hold released" },
  { tone: "r", tag: "402", text: "limit not known, work refused" },
  { tone: "s", tag: "settled", text: "failed halfway, charged 20,000" },
];

function Feed({ reverse = false }: { reverse?: boolean }) {
  const items = reverse ? [...feed].reverse() : feed;
  return (
    <div className={`track ${reverse ? "rev" : ""}`}>
      {[0, 1].map((copy) =>
        items.map((item, i) => (
          <span className="pill" key={`${copy}-${i}`} aria-hidden={copy === 1 ? true : undefined}>
            <b className={item.tone}>{item.tag}</b>
            {item.text}
          </span>
        )),
      )}
    </div>
  );
}

const faq = [
  { q: "Where does the limit come from?", a: "From the customer's plan. With Kinde, Earmark reads the maximum for the feature from the customer's entitlements and keeps it for a minute. Without Kinde, a built-in stand-in lets you set the limit by hand and see the same behavior." },
  { q: "What if the provider is down?", a: "Earmark keeps using the last limit it read for ten minutes. After that it refuses new work until the limit can be read, because spending past a limit that may have changed is the worse mistake." },
  { q: "Does it replace usage reconciliation?", a: "No. Earmark decides whether work may start and what it was charged. Proving that the provider's meter matches what was charged is a separate job." },
  { q: "Do I need a billing account to try it?", a: "No. The built-in stand-in runs with no setup, and the Concurrency Lab shows the difference in a few seconds." },
];

export default async function Home() {
  const owner = await currentOwner();
  const href = owner ? "/app" : kindeReady() ? signInHref() : "/app";
  return (
    <>
      <div className="stage">
        <Nav signedIn={Boolean(owner)} href={href} />
        <svg className="burst" viewBox="0 0 400 400" aria-hidden="true">
          <polygon points={star} fill="#ff7f7f" />
        </svg>
        <header className="hero">
          <p className="count">5 jobs, 1 limit</p>
          <h1>Hold the limit before the work runs.</h1>
          <p className="tag">reserve / run / settle</p>
          <p className="lede">
            A customer has 100,000 tokens a month. Five jobs of 40,000 start at the same moment, and each one sees 100,000 left. Earmark holds part of the limit before a job starts, stops the job at what it holds, and charges the real cost when it ends.
          </p>
          <div className="row">
            <a className="btn coral" href={href}>
              Run the race
            </a>
            <Link className="btn" href="/#how">
              How it works
              <Arrow />
            </Link>
          </div>
        </header>
        <div className="orb-wrap" aria-hidden="true">
          <svg className="orb" viewBox="0 0 340 340">
            <circle cx="170" cy="170" r="170" fill="#22364f" />
            <rect x="60" y="112" width="220" height="30" rx="15" fill="#ede1d0" stroke="#000" strokeWidth="3" />
            <rect x="60" y="112" width="86" height="30" rx="15" fill="#fcdc5f" stroke="#000" strokeWidth="3" />
            <rect x="146" y="112" width="86" height="30" fill="#fcdc5f" stroke="#000" strokeWidth="3" />
            <line x1="232" y1="96" x2="232" y2="158" stroke="#ff7f7f" strokeWidth="4" strokeDasharray="6 5" />
            <rect x="60" y="62" width="86" height="22" rx="11" fill="none" stroke="#ff7f7f" strokeWidth="3" strokeDasharray="5 4" />
            <rect x="156" y="62" width="86" height="22" rx="11" fill="none" stroke="#ff7f7f" strokeWidth="3" strokeDasharray="5 4" />
            <rect x="252" y="62" width="40" height="22" rx="11" fill="none" stroke="#ff7f7f" strokeWidth="3" strokeDasharray="5 4" />
          </svg>
        </div>
      </div>

      <main id="main">
        <section className="section coral" id="problem">
          <div className="marquee" aria-label="Examples of what Earmark answers">
            <Feed />
            <Feed reverse />
          </div>
          <div className="in">
            <h2 className="pixel">A limit check is not a limit</h2>
            <p className="lead">Expensive work takes minutes, and the usage is only counted when the work ends. A check made at the start cannot see the jobs that just started. Four things go wrong.</p>
            <div className="cards">
              <div className="sticker">
                <span className="badge">01</span>
                <h3>Every job passes the check</h3>
                <p>Five jobs start together and each sees 100,000 left. All five run. The customer spends 200,000 on a plan of 100,000.</p>
              </div>
              <div className="sticker">
                <span className="badge">02</span>
                <h3>The job costs more than expected</h3>
                <p>The estimate was 10,000. The model used 15,000. Nothing stopped it, because the check happened once, at the start.</p>
              </div>
              <div className="sticker">
                <span className="badge">03</span>
                <h3>A job fails halfway</h3>
                <p>It spent 60% of its estimate and then stopped. Charge nothing and you give the work away. Charge the estimate and you bill for work that did not happen.</p>
              </div>
              <div className="sticker">
                <span className="badge">04</span>
                <h3>A worker disappears</h3>
                <p>The process is killed in the middle of a job. Whatever was set aside for it stays set aside, and the customer is locked out of their own limit.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="section cream" id="how">
          <div className="in">
            <h2 className="pixel">Reserve, run, settle</h2>
            <p className="lead">The same three steps work for any work that costs usage. Each step is one small transaction, and each one is safe to repeat.</p>
            <div className="steps">
              <div className="step">
                <div className="art" aria-hidden="true">
                  <div className="mini"><i className="h" style={{ width: "40%" }} /></div>
                  <span className="mini-note">40,000 held, 60,000 free</span>
                </div>
                <div className="body">
                  <h3>Reserve</h3>
                  <p>In a single transaction Earmark checks that the whole estimate fits in what is left, and holds it. Used and held are both counted, so two jobs are never promised the same room. If it does not fit, the job is refused with the amount left.</p>
                  <div className="rule">One check, one hold</div>
                </div>
              </div>
              <div className="step">
                <div className="art" aria-hidden="true">
                  <div className="mini"><i className="u" style={{ width: "18%" }} /><i className="h" style={{ width: "22%" }} /></div>
                  <span className="mini-note">18,000 charged, 22,000 still held</span>
                </div>
                <div className="body">
                  <h3>Run</h3>
                  <p>The worker charges each step against the hold before the next step starts. A charge that would pass the hold is cut short and the job stops. Every charge also renews the hold, so a live worker keeps it.</p>
                  <div className="rule">The hold is also the cap</div>
                </div>
              </div>
              <div className="step">
                <div className="art" aria-hidden="true">
                  <div className="mini"><i className="u" style={{ width: "31.2%" }} /></div>
                  <span className="mini-note">31,200 charged, 8,800 returned</span>
                </div>
                <div className="body">
                  <h3>Settle</h3>
                  <p>When the job ends, it is charged for the usage and the rest of the hold goes back. A job whose worker disappeared is settled the same way when its hold runs out. Only settled usage is sent to the billing provider.</p>
                  <div className="rule">Pay for what was used</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section sun" id="api">
          <div className="in split">
            <div className="copy">
              <h2 className="pixel">One call to start work.</h2>
              <p>Send the estimate and a key. A repeat of the same key returns the same job and holds nothing twice.</p>
              <a className="btn dark" href={`${site.repo}#readme`}>
                Read the API
                <Arrow />
              </a>
            </div>
            <div className="panelcode">
              <div className="cap">POST /api/v1/jobs</div>
              <pre>{curl}</pre>
            </div>
          </div>
        </section>

        <section className="section lilac-bg" id="questions">
          <div className="in">
            <h2 className="pixel">Before you use it</h2>
            <div className="faq">
              {faq.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
