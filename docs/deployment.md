# Deployment

## Docker

Build context is the **workspace root**, not `packages/server/` — the
Dockerfile uses `pnpm deploy` to pull `@driftwatch/sdk` in as real files
instead of a workspace symlink, so the runtime image doesn't need the whole
monorepo:

```bash
docker build -f packages/server/Dockerfile -t driftwatch-server .
docker run --rm -p 3000:3000 --env-file packages/server/.env driftwatch-server
```

If you edited `packages/server/src/config/model-client.ts` to use a
provider package other than the bundled `@ai-sdk/openai` (Qwen Cloud)
default, run `pnpm --filter @driftwatch/server add @ai-sdk/<provider>` first
so it lands in the lockfile before building — the Dockerfile installs with
`--frozen-lockfile`.

What the image already does for you (see
[`packages/server/Dockerfile`](../packages/server/Dockerfile)):

- Multi-stage build — the `node_modules`/build toolchain never ships in the
  runtime image.
- Runs as a non-root `app` user (`addgroup`/`adduser`), not root.
- `HEALTHCHECK` hits `/health` every 30s.
- `node --import ./dist/telemetry-bootstrap.js ./dist/server.js` — telemetry
  bootstraps (and OTel auto-instrumentation patches Fastify/http) before the
  server module itself is required. Don't change this to a plain `node
  ./dist/server.js`; instrumentation would miss everything imported before
  it.

## docker-compose with SigNoz

[`docker-compose.override.yml`](../docker-compose.override.yml) is meant to
be merged into (or dropped alongside) SigNoz's own self-host compose file,
so DriftWatch runs on the same Docker network as the SigNoz OTel collector:

```bash
git clone https://github.com/SigNoz/signoz
cd signoz/deploy/docker
docker compose up -d           # brings up SigNoz (UI on :8080)
docker compose -f docker-compose.yaml -f docker-compose.override.yml up -d
```

Adjust the `build.context` path in the override file to wherever you
cloned DriftWatch. Inside that network, `OTEL_EXPORTER_OTLP_ENDPOINT` and
`SIGNOZ_URL` point at the collector/query-service's *service names*
(`otel-collector`, `query-service`), not `localhost` — the override file
already sets this up.

The override file also brings up a **Redis** service and wires
`REDIS_URL=redis://redis:6379` into the DriftWatch container, so autopilot
state is shared and multi-process-safe out of the box. Autopilot itself ships
**disabled** (`AUTOPILOT_ENABLED=0`); flip it on (and set channel secrets) via
your `.env` when you're ready.

## Enabling Autopilot

Autopilot (the drift→remediation loop) is off by default and starts in the
safe `shadow` mode when enabled. A sensible rollout:

1. **Shadow first.** `AUTOPILOT_ENABLED=1 AUTOPILOT_MODE=shadow` — the loop
   runs, evaluates policies, and writes intended actions to the audit log, but
   executes nothing and sends no messages. Watch `/actions/log` (or the
   console) for a cycle or two to confirm the policy does what you expect.
2. **Wire channels.** Set `SLACK_WEBHOOK_URL` + `SLACK_SIGNING_SECRET` and/or
   `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` + `TELEGRAM_SECRET_TOKEN`, and
   register the webhook URLs with each provider (Slack: Interactivity request
   URL → `/integrations/slack/actions`; Telegram: `setWebhook` with your
   secret token → `/integrations/telegram/webhook`).
3. **Enforce.** `AUTOPILOT_MODE=enforce` — notifications fire and control
   actions create approvals that a human resolves from any channel.
4. **Set `REDIS_URL`** for any deployment running more than one process, so
   the leader lock ensures exactly one process runs each drift cycle and all
   processes share approvals/state. Without it you get a single-process
   in-memory store (fine for a single container / local demo).

The console is served from the server at `/console/` when
`packages/console/dist` exists. The Docker build handles this for you — the
build stage also runs `pnpm --filter @driftwatch/console build` and the
runtime image copies its `dist` alongside the deployed server, so
`docker build -f packages/server/Dockerfile -t driftwatch-server .` gives you
both in one image. Open `/console/` with your `AUTH_TOKEN`. For non-Docker
deployments, build the console yourself with
`pnpm --filter @driftwatch/console build` before starting the server.

## Production checklist

- **Set `AUTH_TOKEN`.** Without it, the server only accepts traffic from
  RFC 1918 private ranges — fine for local dev, not for anything with a
  public ingress. See [security.md](./security.md#authentication).
- **Set `TRUST_PROXY=1`** if you're behind a reverse proxy or load
  balancer, so `request.ip` reflects the real client instead of the proxy —
  this also matters for the local-network auth fallback and for rate
  limiting being keyed correctly.
- **Tune `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`** to whatever request
  volume you actually expect; the defaults (30/min) are conservative.
- **Decide on `OTEL_CAPTURE_PAYLOADS`.** If prompts or tool inputs might
  carry customer PII, set it to `0` before your tracing backend becomes a
  second place that data lives.
- **Point `OTEL_EXPORTER_OTLP_ENDPOINT` and `SIGNOZ_URL` at your real
  collector/query-service**, not `localhost` defaults.
- **Cap `AGENT_MAX_STEPS`** to bound per-request cost — this is your hard
  ceiling on how many tool-use/LLM round trips a single `/run` call can
  spend.
- **Set the inline guardrails** (`AGENT_MAX_TOKENS_PER_TASK` / `AGENT_MAX_COST_USD`)
  for a synchronous, per-request abort that fires before a runaway call can
  even reach the drift windows.
- **If Autopilot is enabled**, run `shadow` mode until you trust the policy,
  set `REDIS_URL` for multi-process deployments, and keep
  `AUTOPILOT_APPROVAL_TIMEOUT_DECISION=rejected` (the safe default) so a
  missed approval fails closed.
- **Graceful shutdown is already handled** — `SIGTERM`/`SIGINT` drain
  in-flight Fastify requests before flushing OTel and exiting (see
  [`server.ts`](../packages/server/src/server.ts)), so a rolling deploy or
  autoscaler-driven termination won't cut off in-flight `/run` calls or
  drop the last batch of spans.
- **`/health` is unauthenticated by design** (for load balancer / container
  orchestrator health checks) — it returns `{ ok: true }` and nothing else,
  no information disclosure beyond liveness.

## Publishing `@driftwatch/sdk`

The SDK package (`packages/sdk`) is structured to be publishable
standalone — `files: ["dist"]`, a package-local README, `publishConfig:
{"access": "public"}` for the scoped name. It is **not yet published to
npm**, but `@driftwatch/sdk`/`driftwatch` are confirmed available (unlike
the earlier `@agentpulse/*` working name, which collided with an existing
package). Before running `npm publish` for real:

1. Create/claim the `driftwatch` npm org so the `@driftwatch` scope
   resolves to you.
2. Bump the version and fill in `packages/sdk/CHANGELOG.md`.
3. `pnpm --filter @driftwatch/sdk build && pnpm --filter @driftwatch/sdk publish`.
