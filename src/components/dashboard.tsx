"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { api } from "../../convex/_generated/api";
import { n, stamp } from "@/lib/format";

type Overview = typeof api.gate.overview["_returnType"];
type Race = { mode: "earmark" | "naive"; limit: number; jobs: number; admitted: number; refused: number; spent: number; over: number };

async function call<T>(url: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

const pct = (part: number, whole: number) => (whole <= 0 ? 0 : Math.min(100, (part / whole) * 100));

function UsageBar({ view }: { view: Overview }) {
  const { limit, used, held, remaining } = view.budget;
  const total = limit ?? Math.max(1, used + held);
  return (
    <section className="panel" aria-labelledby="usage-h">
      <h2 id="usage-h">This cycle ({view.budget.cycle})</h2>
      <p className="hint">
        {limit === null ? "The plan limit has not been read yet." : `The plan allows ${n(limit)} ${view.billing.featureCode}.`} A hold is a promise to a running job. Only settled usage is billed.
      </p>
      <div className="bar" role="img" aria-label={`${n(used)} used, ${n(held)} held, ${remaining === null ? "unknown" : n(remaining)} free`}>
        <div className="used" style={{ width: `${pct(used, total)}%` }} />
        <div className="held" style={{ width: `${pct(held, total)}%` }} />
      </div>
      <div className="legend">
        <div><span className="k"><i className="dot" style={{ background: "var(--used)" }} />Used</span><div className="v">{n(used)}</div></div>
        <div><span className="k"><i className="dot" style={{ background: "var(--held)" }} />Held</span><div className="v">{n(held)}</div></div>
        <div><span className="k"><i className="dot" style={{ background: "var(--free)", border: "1px solid var(--line)" }} />Free</span><div className="v">{remaining === null ? "Unknown" : n(remaining)}</div></div>
        <div>
          <span className="k">{view.provider === "kinde" ? "Sent to Kinde" : "Built-in meter"}</span>
          <div className="v">{view.provider === "kinde" ? (view.budget.reported === null ? "Nothing yet" : n(view.budget.reported)) : view.budget.meter === null ? "Nothing yet" : n(view.budget.meter)}</div>
        </div>
      </div>
      {view.budget.reportError && <p className="msg bad">The last report failed and will be tried again: {view.budget.reportError}</p>}
    </section>
  );
}

const SCENARIOS = [
  { id: "same", label: "Costs what was estimated" },
  { id: "more", label: "Costs more than estimated (150%)" },
  { id: "fail", label: "Fails halfway" },
  { id: "crash", label: "Worker disappears halfway" },
];

function plan(scenario: string, estimate: number) {
  const actual = scenario === "more" ? Math.round(estimate * 1.5) : estimate;
  const base = { actual, step_ms: 400, step_tokens: Math.max(1, Math.round(estimate / 10)) };
  if (scenario === "fail") return { ...base, fail_after: Math.round(actual / 2) };
  if (scenario === "crash") return { ...base, crash_after: Math.round(actual / 2) };
  return base;
}

function SubmitJob({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState("Summarize 40 PDFs");
  const [estimate, setEstimate] = useState("40000");
  const [scenario, setScenario] = useState("same");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (count: number) => {
    const size = Number(estimate);
    if (!Number.isInteger(size) || size < 1) return setMessage({ ok: false, text: "The estimate must be a whole number of 1 or more." });
    setBusy(true);
    setMessage(null);
    const answers = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        call<{ admitted?: boolean; reason?: string; remaining?: number }>("/api/v1/jobs", "POST", { label: count > 1 ? `${label} ${i + 1}` : label, estimate: size, simulate: plan(scenario, size) }),
      ),
    );
    const admitted = answers.filter((a) => a.data.admitted).length;
    const first = answers.find((a) => !a.data.admitted);
    setMessage(
      first?.data.error
        ? { ok: false, text: first.data.error }
        : { ok: admitted > 0, text: `${admitted} of ${count} started.${first?.data.reason ? ` ${first.data.reason}` : ""}` },
    );
    setBusy(false);
    onDone();
  };

  return (
    <section className="panel" aria-labelledby="submit-h">
      <h2 id="submit-h">Start work</h2>
      <p className="hint">Each job holds its estimate, runs for a few seconds, and is charged for what it used.</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(1); }}>
        <label>Job<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></label>
        <label>Estimate (tokens held)<input value={estimate} onChange={(e) => setEstimate(e.target.value)} inputMode="numeric" /></label>
        <label>What the work really does
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>{SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        </label>
        <div className="row">
          <button className="btn coral" disabled={busy}>Start one job</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void send(5)}>Start five at once</button>
        </div>
      </form>
      {message && <p className={`msg ${message.ok ? "ok" : "bad"}`}>{message.text}</p>}
    </section>
  );
}

function PlanPanel({ view, builtin, onDone }: { view: Overview; builtin: boolean; onDone: () => void }) {
  const [limit, setLimit] = useState(String(view.billing.limit ?? 100000));
  const [customer, setCustomer] = useState(view.billing.customerId ?? "");
  const [agreement, setAgreement] = useState(view.billing.agreementId ?? "");
  const [start, setStart] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    const result = builtin
      ? await call("/api/v1/billing", "PATCH", { limit: Number(limit) })
      : await call("/api/v1/billing", "POST", { customer_id: customer, agreement_id: agreement, ...(start.trim() ? { cycle_start: start.trim() } : {}) });
    setMessage({ ok: result.ok, text: result.ok ? "Saved." : (result.data.error ?? "Could not save.") });
    onDone();
  };

  return (
    <section className="panel" aria-labelledby="plan-h">
      <h2 id="plan-h">Plan limit</h2>
      {builtin ? (
        <>
          <p className="hint">The built-in provider. Change the limit the way a plan change in Kinde would. Running jobs keep their holds.</p>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label>Limit for this cycle<input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="numeric" /></label>
            <div className="row"><button className="btn lilac">Change plan</button></div>
          </form>
        </>
      ) : (
        <>
          <p className="hint">
            The limit is read from the customer&apos;s Kinde entitlements{view.billing.limitCheckedAt ? ` (last read ${stamp(view.billing.limitCheckedAt)} UTC)` : ""}.
          </p>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label>Billing customer id<input value={customer} onChange={(e) => setCustomer(e.target.value)} /></label>
            <label>Agreement id<input value={agreement} onChange={(e) => setAgreement(e.target.value)} /></label>
            <label>Agreement start, UTC (set before the first job)<input value={start} onChange={(e) => setStart(e.target.value)} placeholder="2026-10-20T15:29:00Z" disabled={view.billing.cycleStart !== null} /></label>
            <div className="row"><button className="btn lilac">Save</button></div>
          </form>
        </>
      )}
      {message && <p className={`msg ${message.ok ? "ok" : "bad"}`}>{message.text}</p>}
    </section>
  );
}

function Jobs({ view }: { view: Overview }) {
  return (
    <section className="panel" aria-labelledby="jobs-h">
      <h2 id="jobs-h">Jobs</h2>
      {view.jobs.length === 0 ? (
        <p className="hint">No jobs yet. Start one above.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job</th><th>Status</th><th className="n">Estimate</th><th className="n">Held</th><th className="n">Used</th></tr></thead>
            <tbody>
              {view.jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.label}{j.mode === "naive" && <span className="note"> (no hold)</span>}{j.reason && <div className="note">{j.reason}</div>}</td>
                  <td><span className={`chip ${j.status}`}>{j.status}</span></td>
                  <td className="n">{n(j.estimate)}</td>
                  <td className="n">{j.held ? n(j.held) : "–"}</td>
                  <td className="n">{n(j.used)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view.settlements.length > 0 && (
        <>
          <h2 style={{ marginTop: 28 }}>Settlements</h2>
          <p className="hint">One row for each job that ended. The hold goes back except for what the job used.</p>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Ended (UTC)</th><th>Result</th><th className="n">Held</th><th className="n">Charged</th><th className="n">Returned</th></tr></thead>
              <tbody>
                {view.settlements.map((s) => (
                  <tr key={s.id}><td className="mono">{stamp(s.at)}</td><td><span className={`chip ${s.status}`}>{s.status}</span></td><td className="n">{n(s.held)}</td><td className="n">{n(s.charged)}</td><td className="n">{n(s.released)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Lab() {
  const [results, setResults] = useState<{ naive?: Race; earmark?: Race } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResults(null);
    const [naive, earmark] = await Promise.all([call<Race>("/api/v1/lab", "POST", { mode: "naive" }), call<Race>("/api/v1/lab", "POST", { mode: "earmark" })]);
    if (!naive.ok || !earmark.ok) setError(naive.data.error ?? earmark.data.error ?? "The lab could not run.");
    else setResults({ naive: naive.data, earmark: earmark.data });
    setBusy(false);
  };

  const card = (r: Race | undefined, title: string, kind: "bad" | "ok") =>
    r && (
      <div className={`result ${r.over > 0 ? "bad" : kind === "ok" ? "ok" : ""}`}>
        <h3>{title}</h3>
        <div className="big">{n(r.spent)} spent</div>
        <dl>
          <dt>Plan limit</dt><dd>{n(r.limit)}</dd>
          <dt>Jobs started</dt><dd>{r.admitted} of {r.jobs}</dd>
          <dt>Jobs refused</dt><dd>{r.refused}</dd>
          <dt>Spent past the limit</dt><dd>{r.over > 0 ? n(r.over) : "None"}</dd>
        </dl>
      </div>
    );

  return (
    <section className="panel" aria-labelledby="lab-h">
      <h2 id="lab-h">Concurrency Lab</h2>
      <p className="hint">Five jobs of 40,000 start at the same moment on a plan of 100,000. The left side only checks what is already spent. The right side holds capacity first.</p>
      <div className="row" style={{ marginTop: 14 }}><button className="btn coral" onClick={() => void run()} disabled={busy}>{busy ? "Running…" : "Run the race"}</button></div>
      {error && <p className="msg bad">{error}</p>}
      {results && <div className="lab">{card(results.naive, "Check, then run", "bad")}{card(results.earmark, "Hold, run, settle", "ok")}</div>}
    </section>
  );
}

export function Dashboard({ initial, builtin }: { initial: Overview; builtin: boolean }) {
  const [view, setView] = useState(initial);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/v1/overview", { cache: "no-store" });
    if (response.ok && alive.current) setView(await response.json());
  }, []);

  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return (
    <>
      <h1>Earmark</h1>
      <p className="sub">Hold the limit before the work runs.</p>
      <UsageBar view={view} />
      <div className="two">
        <SubmitJob onDone={refresh} />
        <PlanPanel key={String(view.billing.limit)} view={view} builtin={builtin} onDone={refresh} />
      </div>
      <Jobs view={view} />
      {builtin && <Lab />}
    </>
  );
}
