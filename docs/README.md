# DriftWatch docs

DriftWatch is an AI agent SDK that **observes itself**. Every skill (tool)
call and LLM step is traced via OpenTelemetry into a backend like
[SigNoz](https://signoz.io), and an AI layer on top of those traces flags
**behavioral drift** — shifts in tool-call mix, error rate, latency, or
token spend between two time windows.

> One line: instrument an agent's decisions as telemetry, then run an LLM
> over that telemetry to notice when the agent starts behaving differently.

This is a pnpm workspace with two packages:

| Package | What it is |
|---|---|
| [`packages/sdk`](../packages/sdk) (`@driftwatch/sdk`) | Publishable. Zero AI provider SDKs bundled, zero direct `process.env` access. Every function takes typed config/clients as parameters. |
| [`packages/server`](../packages/server) (`@driftwatch/server`) | The reference Fastify app. Depends on the SDK via `workspace:*`, supplies demo skills, and holds the one file where you wire up a real model provider. |

## Guides

1. **[Quickstart](./quickstart.md)** — bring up SigNoz, configure a model,
   run the server, drive traffic, get a drift report. Start here.
2. **[Configuration reference](./configuration.md)** — every env var / typed
   config field for both the SDK and the reference server.
3. **[Architecture](./architecture.md)** — request flow, what gets traced,
   how drift detection works.
4. **[Deployment](./deployment.md)** — Docker, docker-compose with SigNoz,
   production checklist.
5. **[Security](./security.md)** — auth model, rate limiting, telemetry
   payload capture, and what's still on you.

## Using just the SDK

If you don't want the reference server at all, `@driftwatch/sdk` works
standalone — see [`packages/sdk/README.md`](../packages/sdk/README.md) for
an install + quickstart aimed at that use case.

## The root README

[`../README.md`](../README.md) is the single-file version of all of the
above, written for someone who wants everything in one scroll. These docs
exist for when you want to jump straight to one topic.
