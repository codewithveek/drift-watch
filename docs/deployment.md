# Deployment

## Docker

Build context is the **workspace root**, not `packages/server/` — the
Dockerfile uses `pnpm deploy` to pull `@agentpulse/sdk` in as real files
instead of a workspace symlink, so the runtime image doesn't need the whole
monorepo:

```bash
docker build -f packages/server/Dockerfile -t agentpulse-server .
docker run --rm -p 3000:3000 --env-file packages/server/.env agentpulse-server
```

If you edited `packages/server/src/config/model-client.ts` to use a
provider package other than the built-in gateway default, run
`pnpm --filter @agentpulse/server add @ai-sdk/<provider>` first so it lands
in the lockfile before building — the Dockerfile installs with
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
so AgentPulse runs on the same Docker network as the SigNoz OTel collector:

```bash
git clone https://github.com/SigNoz/signoz
cd signoz/deploy/docker
docker compose up -d           # brings up SigNoz (UI on :8080)
docker compose -f docker-compose.yaml -f docker-compose.override.yml up -d
```

Adjust the `build.context` path in the override file to wherever you
cloned AgentPulse. Inside that network, `OTEL_EXPORTER_OTLP_ENDPOINT` and
`SIGNOZ_URL` point at the collector/query-service's *service names*
(`otel-collector`, `query-service`), not `localhost` — the override file
already sets this up.

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
- **Graceful shutdown is already handled** — `SIGTERM`/`SIGINT` drain
  in-flight Fastify requests before flushing OTel and exiting (see
  [`server.ts`](../packages/server/src/server.ts)), so a rolling deploy or
  autoscaler-driven termination won't cut off in-flight `/run` calls or
  drop the last batch of spans.
- **`/health` is unauthenticated by design** (for load balancer / container
  orchestrator health checks) — it returns `{ ok: true }` and nothing else,
  no information disclosure beyond liveness.

## Publishing `@agentpulse/sdk`

The SDK package (`packages/sdk`) is structured to be publishable
standalone — `files: ["dist"]`, a package-local README, `publishConfig:
{"access": "public"}` for the scoped name. It is **not currently published**:
the `agentpulse` name is already taken on npm under an unrelated project,
so `@agentpulse/sdk` is a working name, not a reserved one. Before running
`npm publish` for real:

1. Pick and reserve an actual package name/scope (see the suggestion at the
   end of the root README's discussion, or search npm directly).
2. Rename the package in `packages/sdk/package.json` and update the
   `@agentpulse/sdk` imports across `packages/server`.
3. Bump the version and fill in `packages/sdk/CHANGELOG.md`.
