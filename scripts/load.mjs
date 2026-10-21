// Sends many jobs at the same moment and checks that the limit holds.
// Usage: node scripts/load.mjs [--jobs 120] [--estimate 1000] [--limit 100000] [--concurrency 50] [--url http://localhost:3000] [--token local-dev]
// An account can start 120 jobs a minute, so keep --jobs at 120 or less for one run.
// It works against a local server with the built-in provider. The jobs are real: they hold, run and settle like any other.
const args = Object.fromEntries(process.argv.slice(2).reduce((out, a, i, all) => (a.startsWith("--") ? [...out, [a.slice(2), all[i + 1]]] : out), []));
const jobs = Number(args.jobs ?? 120);
const estimate = Number(args.estimate ?? 1000);
const limit = Number(args.limit ?? 100000);
const concurrency = Number(args.concurrency ?? 50);
const base = (args.url ?? "http://localhost:3000").replace(/\/$/, "");
const headers = { authorization: `Bearer ${args.token ?? "local-dev"}`, "content-type": "application/json" };

const read = async (response) => {
  try {
    return await response.json();
  } catch {
    throw new Error(`${base} did not answer like Earmark. Another app may be using that port. Check the port in the "npm run dev" output and run again with --url http://localhost:<port>.`);
  }
};
const get = async (path) => read(await fetch(base + path, { headers }));
const patch = async (path, body) => read(await fetch(base + path, { method: "PATCH", headers, body: JSON.stringify(body) }));

// Start from a known plan. Anything already held or spent in this cycle counts against it, so use a fresh account for a clean run.
const before = await get("/api/v1/overview");
if (before.error) throw new Error(before.error);
await patch("/api/v1/billing", { limit });
const startUsed = before.budget.used;
console.log(`Limit ${limit.toLocaleString("en-US")}. Already used in this cycle: ${startUsed.toLocaleString("en-US")}. Sending ${jobs} jobs of ${estimate.toLocaleString("en-US")}, ${concurrency} at a time.`);

const stamp = Date.now();
const times = [];
const answers = { admitted: 0, refused: 0, error: 0 };
const failures = new Map();
const noteFailure = (text) => failures.set(text, (failures.get(text) ?? 0) + 1);
let next = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < jobs) {
      const i = next++;
      const t0 = performance.now();
      try {
        const response = await fetch(`${base}/api/v1/jobs`, {
          method: "POST",
          headers: { ...headers, "idempotency-key": `load-${stamp}-${i}` },
          body: JSON.stringify({ label: `Load job ${i + 1}`, estimate, simulate: { actual: estimate, step_ms: 0 } }),
        });
        times.push(performance.now() - t0);
        if (response.status === 202) answers.admitted++;
        else if (response.status === 402) answers.refused++;
        else {
          answers.error++;
          const body = await response.json().catch(() => ({}));
          noteFailure(`${response.status} ${String(body.error ?? body.reason ?? "").slice(0, 160)}`);
        }
      } catch (error) {
        answers.error++;
        noteFailure(`no answer: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160));
      }
    }
  }),
);
const seconds = (performance.now() - started) / 1000;

// Wait for the admitted jobs to end, then read the budget.
let view = await get("/api/v1/overview");
for (let i = 0; i < 120 && view.budget.held > 0; i++) {
  await new Promise((r) => setTimeout(r, 500));
  view = await get("/api/v1/overview");
}
times.sort((a, b) => a - b);
const pick = (p) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0);
const spent = view.budget.used - startUsed;
console.log(`\n${jobs} requests in ${seconds.toFixed(1)}s, ${Math.round(jobs / seconds)} a second`);
console.log(`started ${answers.admitted}, refused ${answers.refused}, failed ${answers.error}`);
for (const [text, count] of failures) console.log(`  failed ${count}x: ${text}`);
console.log(`start time: median ${pick(0.5)} ms, 95th ${pick(0.95)} ms, 99th ${pick(0.99)} ms`);
console.log(`spent ${spent.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")}, held now ${view.budget.held.toLocaleString("en-US")}, used in cycle ${view.budget.used.toLocaleString("en-US")}`);
const ok = view.budget.used <= limit && view.budget.held === 0 && answers.error === 0;
console.log(ok ? "The limit held." : "The limit did not hold, or some requests failed. Check the numbers above.");
process.exit(ok ? 0 : 1);
