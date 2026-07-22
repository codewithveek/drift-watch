# The Console

The console is the operator's window into a running agent: its live health, the
drift verdicts as they land, the queue of actions waiting for a human decision,
and a full audit log of everything Autopilot has done. It's where you approve or
reject a pause, watch a rollout in shadow mode, or check why the agent got
throttled at 3am.

It's a browser app served **by the server** at `/console/` — there's nothing
separate to deploy. The Docker image builds and bundles it automatically.

## Opening it

1. Browse to `http://<your-host>:3000/console/`.
2. Click **Connect** and paste your `AUTH_TOKEN` (the same bearer token the
   control-plane API uses). It's stored in your browser's `localStorage`, so it
   survives refreshes — no login screen, no separate accounts.

That's the whole setup. The console polls the control-plane API every few
seconds with that token; if a panel says data is unavailable, the token is
wrong or the server is unreachable.

> In local development you can run the console's own dev server for hot reload —
> `pnpm --filter @driftwatch/console dev` — which proxies API calls to the
> server on `:3000`. In production it's always the bundled `/console/`.

## What each panel shows

**Agent health** — the agent's current status (`running` / `paused` /
`throttled`), its active model and version, whether Autopilot is enabled and in
which mode (`shadow` / `enforce`), and the guardrail caps in effect. Your
at-a-glance "is it healthy and who's in control" strip.

**Pending approvals** — control actions waiting on a human. Each card shows the
proposed action (pause, rollback, …), the drift severity that triggered it, the
reasons, and the recommended action, with **Approve** / **Reject** buttons.
Resolving here is equivalent to clicking the button in Slack or Telegram — it's
the same approval, and the first response anywhere wins.

**Drift verdicts** — the running feed of drift reports: for each cycle, whether
drift was detected, the severity, the reasons, and the baseline-vs-current token
spend. This is the history that tells you whether the agent's behavior has been
stable or wandering.

**Action & audit log** — every action Autopilot took or *would have* taken:
notifications sent, approvals created and resolved (with who approved and via
which channel), control actions executed, and — in shadow mode — the ones it
only logged. This is your record of what happened and why.

## Manual controls

Beyond approving Autopilot's proposals, the console lets you drive the agent
directly: **pause**, **resume**, or **rollback** on demand, and trigger a drift
**scan** immediately instead of waiting for the next scheduled cycle. Useful for
incident response, or for testing that your policy and channels are wired up.

## When to use it vs. Slack/Telegram

- **Slack/Telegram** are for *acting fast* — approve or reject a single decision
  from wherever you are, including your phone.
- **The console** is for *seeing the whole picture* — the health strip, the drift
  history, and the full audit trail in one place, plus the manual controls.

They're fully interchangeable for approvals because they all resolve the same
shared state. See [alerts-and-actions.md](./alerts-and-actions.md) for the
channels and the approval flow.
