# DriftWatch documentation

DriftWatch is a self-observing AI agent platform. Every tool call and model step
an agent makes is traced as OpenTelemetry into a backend like
[SigNoz](https://signoz.io); an LLM watches that telemetry for **behavioral
drift** — shifts in tool-call mix, error rate, latency, or token spend — and a
policy-driven **autopilot** turns drift into action (notify, pause, rollback,
throttle) with a human in the loop for anything destructive.

> **In one line:** instrument an agent's decisions as telemetry, run a model
> over that telemetry to notice when it starts behaving differently, and act on
> it — safely.

## Why it matters

Agents fail quietly. A model update, a prompt tweak, or a shifting workload can
change *how* an agent behaves — which tools it reaches for, how much it spends,
how often it errors — long before anything throws an exception. DriftWatch makes
that behavior visible, tells you when it changes enough to care, and can step in
before a quiet regression becomes an incident or a bill.

## Start here

1. **[Quickstart](./quickstart.md)** — run it with Docker and get your first
   drift report in minutes.

## Guides

| Guide | What it covers |
|---|---|
| [How it works](./architecture.md) | The big picture — request flow, what gets traced, and the perceive → reason → act loop. |
| [SDK](./sdk.md) | `@driftwatch/sdk` — add observability, drift detection, and guardrails to your own AI SDK agent. |
| [Server](./server.md) | The ready-to-run HTTP service — endpoints, model client, and your own tools. |
| [SigNoz & OpenTelemetry](./signoz.md) | Connect SigNoz (Cloud or self-hosted), what to look at, and the signals DriftWatch emits. |
| [Alerts & Actions](./alerts-and-actions.md) | Autopilot — policies, Slack/Telegram/webhook channels, and the approval flow. |
| [Console](./console.md) | The operator console — health, drift feed, approvals, audit log. |
| [Configuration](./configuration.md) | Every environment variable and typed config field. |
| [Deployment](./deployment.md) | Production Docker, compose, Redis, and the go-live checklist. |
| [Security](./security.md) | Auth, rate limiting, webhook signatures, and payload capture. |

## The three packages

| Package | What it is |
|---|---|
| **`@driftwatch/sdk`** | The reusable library: telemetry, drift detection, inline guardrails, and the pure policy engine. Bundles no provider SDKs; every function takes typed config and clients as parameters. Use it standalone in your own app. |
| **`@driftwatch/server`** | The reference Fastify service built on the SDK: the `/run` and `/drift` endpoints, the autopilot loop, the control-plane API, notifiers, and shared state. Deploy this to run DriftWatch as a service. |
| **`@driftwatch/console`** | The operator web console (approvals, drift feed, action log, health). Served by the server at `/console/`. |
