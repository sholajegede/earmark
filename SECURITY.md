# Security

## Report a problem

Do not open a public issue for a security problem. Use the "Report a vulnerability" button on the Security tab of the GitHub repository, which opens a private report. Include:

- what you found and where
- the steps to repeat it
- what you think it allows

You will get an answer within a few days. Please give a fair time to fix the problem before you share it.

## What to look for

Problems that matter most in Earmark:

- a way to start work past a plan limit, or to hold more than the limit allows
- a way to make a job spend past its hold
- a way to charge a job twice, or to settle another account's job
- a way to read or change another account's jobs, budgets or limit
- a way to call the Convex functions without the server key
- a way to use the unsafe lab mode with a real provider

## What Earmark keeps

For each job: a label, the estimate, what was held and used, the status, and the times. It keeps no content of the work itself. Secrets (the server key and the Kinde client secrets) belong in `.env.local`, Vercel and Convex, and never in the repository.
