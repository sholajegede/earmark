# Contributing to Earmark

Bug reports and pull requests are welcome.

## Set up

You need Node.js 22 or later and a Convex account.

```bash
git clone https://github.com/sholajegede/earmark.git
cd earmark
npm install
npx convex dev
npm run setup
npm run dev
```

With no Kinde settings, Earmark runs on your machine with a local account and a built-in stand-in for the plan limit and the meter.

## Checks

Run all three before you open a pull request:

```bash
npm test
npm run typecheck
npm run lint
```

## What a good change looks like

- It does one thing, and the pull request says what and why.
- A change to the gate, the worker, settlement or the reporter has a test that fails without it.
- The check and the hold happen in one transaction. If your change splits them, say how two jobs still cannot be promised the same capacity.
- A job settles once. A second finish must charge nothing more.
- A worker can never spend past its hold.
- The meter is written with an absolute write, and only with settled usage. A hold is never sent as usage.
- Text in the interface is short and plain.

## Commits

Use a short, clear message that says what changed. One change per commit.

## Security

Do not open a public issue for a security problem. Follow [SECURITY.md](SECURITY.md).
