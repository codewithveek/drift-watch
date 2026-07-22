# Deployment

DriftWatch deploys as a single container that serves the API **and** the
console. Docker is the primary path; the compose file adds Redis for shared
state in one command.

## Docker (single container)

Build from the workspace root (the Dockerfile pulls the SDK in as real files, so
the runtime image doesn't need the monorepo):

```bash
docker build -f packages/server/Dockerfile -t driftwatch .
docker run --rm -p 3000:3000 --env-file packages/server/.env driftwatch
```

The image is production-ready out of the box:

- Multi-stage build — the build toolchain never ships in the runtime image.
- Runs as a non-root user.
- `HEALTHCHECK` polls `/health` every 30s.
- Bundles the console (served at `/console/`).
- Starts telemetry before the app loads, so instrumentation catches everything.

Publish it to any registry and run it anywhere that runs containers (ECS, Cloud
Run, Fly, Kubernetes, a plain VM).

> If you changed the model client to a provider package other than the default,
> add it to the lockfile first (`pnpm --filter @driftwatch/server add
> @ai-sdk/<provider>`) — the build installs with `--frozen-lockfile`.

## docker-compose (the standard path)

The root [`docker-compose.yml`](../docker-compose.yml) brings up **DriftWatch +
Redis** with no other services required — this is what auto-deploy platforms
(Coolify, Railway, etc.) pick up automatically:

```bash
docker compose up -d --build
```

It wires `REDIS_URL` into the container so Autopilot state is shared and
multi-process-safe from the start. Set your secrets (`QWEN_API_KEY`,
`AUTH_TOKEN`, and any telemetry/channel vars) as environment variables — the
compose file substitutes them at deploy time; on a PaaS, set them in that
platform's environment UI.

Telemetry export is optional here: left at their `localhost` defaults the OTLP
endpoint and `SIGNOZ_URL` are unreachable inside the container, so the exporter
just logs failures and the server runs normally. Point them at a real
collector/query service ([signoz.md](./signoz.md)) when you're ready.

## Running alongside self-hosted SigNoz

To run DriftWatch on the **same Docker network** as a self-hosted SigNoz — so it
can reach the collector and query service by name — use
[`docker-compose.signoz.yml`](../docker-compose.signoz.yml). It's meant to be
merged with SigNoz's own compose file (it references SigNoz's `otel-collector`
and `query-service` services, which only exist once merged):

```bash
git clone https://github.com/SigNoz/signoz && cd signoz/deploy/docker
docker compose up -d                                  # SigNoz, UI on :8080
docker compose -f docker-compose.yaml \
  -f /path/to/drift-watch/docker-compose.signoz.yml up -d
```

Inside that network, `OTEL_EXPORTER_OTLP_ENDPOINT` and `SIGNOZ_URL` use the
service names, not `localhost` — the file sets this up and brings up its own
Redis. (Deploying this file *by itself* fails with "undefined service
otel-collector"; for standalone deploys use the plain `docker-compose.yml`.)

## Shared state with Redis

Set `REDIS_URL` for any deployment running **more than one process**. It holds
pending approvals, agent state, drift history, and the Autopilot leader lock, so
that:

- all processes see the same approvals and can resolve them, and
- a `SET NX PX` leader lock ensures exactly one process runs each drift cycle.

Without it you get an in-memory single-process store — fine for one container or
local dev, wrong for a horizontally scaled deployment. Put Redis on a private
network; use `rediss://` + auth if it leaves the host.

## Production checklist

- **Set `AUTH_TOKEN`.** Without it the server only accepts private-network
  traffic — fine for dev, not for a public ingress.
  ([security.md](./security.md#authentication))
- **Set `TRUST_PROXY=1`** behind a reverse proxy or load balancer, so client IP,
  the local-network auth fallback, and rate limiting key on the real client.
- **Point telemetry at your real backend** — `OTEL_EXPORTER_OTLP_ENDPOINT` /
  `OTEL_EXPORTER_OTLP_HEADERS` for push, `SIGNOZ_URL` / `SIGNOZ_API_KEY` for the
  drift detector's pull. ([signoz.md](./signoz.md))
- **Decide on `OTEL_CAPTURE_PAYLOADS`.** Set it to `0` if prompts or tool inputs
  might carry PII before your tracing backend becomes a second place that data
  lives. ([security.md](./security.md#telemetry-payload-capture))
- **Bound cost.** Cap `AGENT_MAX_STEPS`, and set the inline guardrails
  (`AGENT_MAX_TOKENS_PER_TASK` / `AGENT_MAX_COST_USD`) for a hard per-request
  abort. Tune `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` for your traffic.
- **If Autopilot is on**, roll out in `shadow` mode first, set `REDIS_URL` for
  multi-process, and keep `AUTOPILOT_APPROVAL_TIMEOUT_DECISION=rejected` so a
  missed approval fails closed. ([alerts-and-actions.md](./alerts-and-actions.md))
- **Graceful shutdown is handled** — `SIGTERM`/`SIGINT` drain in-flight requests
  before flushing telemetry, so rolling deploys don't cut off `/run` calls or
  drop the last batch of spans.
- **`/health` is unauthenticated by design** — liveness only, no information
  disclosure, for load balancers and orchestrators.

## Configuration

Every environment variable, with defaults, is in
[configuration.md](./configuration.md). The shipped
[`.env.example`](../packages/server/.env.example) has them all with inline
comments, ready to copy.
