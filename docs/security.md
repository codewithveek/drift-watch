# Security

## Authentication

`/run` and `/drift` are gated by `isRequestAuthorized` in
[`routes/agent.ts`](../packages/server/src/routes/agent.ts):

- **`AUTH_TOKEN` set** — requests must send `Authorization: Bearer <token>`.
  The comparison uses `crypto.timingSafeEqual` (after an equal-length
  fast-path check) rather than `===`, so response timing can't be used to
  recover the token byte by byte.
- **`AUTH_TOKEN` unset (local-only mode)** — the server refuses everything
  outside RFC 1918 private ranges: `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, plus loopback. This exists because model calls cost
  real money — there's no anonymous-by-accident path to production.

`request.ip` is what this check keys on, which means **`TRUST_PROXY` must
be set correctly** — if the server sits behind a reverse proxy and
`TRUST_PROXY` is unset, `request.ip` is the proxy's address, not the
client's, which can make the local-network fallback either too permissive
or too strict depending on where the proxy lives. See
[configuration.md](./configuration.md#server-config--serverconfig).

`/health` is intentionally unauthenticated — it returns `{ ok: true }` and
nothing else, for load balancer / orchestrator health checks.

## Rate limiting

`/run` and `/drift` are rate-limited via
[`@fastify/rate-limit`](https://github.com/fastify/fastify-rate-limit),
`RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` per client (default
30/60s). This exists specifically because a single leaked or shared
`AUTH_TOKEN` shouldn't translate into unbounded model-provider spend — the
body-size cap (`MAX_PROMPT_BYTES`/`BODY_LIMIT`) bounds cost *per request*,
this bounds it *per unit time*.

## Request size limits

- `MAX_PROMPT_BYTES` (default 8 KiB) caps the `prompt` field specifically.
- `BODY_LIMIT` (default 128 KiB) caps the overall request body Fastify will
  accept, independent of the prompt-specific check.

## Telemetry payload capture

By default, `agent.run` spans carry the first 512 bytes of the prompt
(`agent.prompt`), and `tool.<name>` spans carry the tool's input JSON,
similarly truncated (`agent.tool.input`) — see
[`agent/runner.ts`](../packages/sdk/src/agent/runner.ts) and
[`telemetry/instrument.ts`](../packages/sdk/src/telemetry/instrument.ts).
This is genuinely useful for debugging ("what did the user actually ask
that made the agent call this tool?"), but it also means anything sensitive
a user types, or any PII a tool call carries, lands in your tracing
backend's storage (ClickHouse, if you're running SigNoz self-hosted) —
usually for as long as that backend retains data, which is a separate
retention policy you control there, not in DriftWatch.

Set `OTEL_CAPTURE_PAYLOADS=0` (or `TelemetryConfig.capturePayloads = false`
if building config programmatically) to stop attaching this content to
spans. Span/metric *names*, counts, latencies, and token usage are
unaffected — you lose the raw content, not the shape of what happened. The
toggle is process-wide, set once by `bootstrapTelemetry` via
[`telemetry/capture-config.ts`](../packages/sdk/src/telemetry/capture-config.ts),
rather than threaded through every call site — it's a deployment-wide
compliance decision, not a per-request one.

## SigNoz credentials

`SIGNOZ_API_KEY` is sent as a `SIGNOZ-API-KEY` header on every drift-window
query — treat it like any other API key (don't commit it, rotate it via the
SigNoz UI if leaked). `SIGNOZ_URL` is operator-configured, not derived from
any user input, so it isn't an SSRF vector from request traffic — but
double-check it before pointing a production deployment at it.

## Graceful shutdown

`SIGTERM`/`SIGINT` trigger an ordered shutdown in
[`server.ts`](../packages/server/src/server.ts): Fastify closes (draining
in-flight requests) *before* the OTel SDK flushes its last batch of spans
and metrics, and only then does the process exit. This matters under a
rolling deploy or autoscaler-driven termination — without the ordering, a
race between two independent `process.exit(0)` callers could cut off
in-flight `/run` calls or drop the final export.

## What's still on you

- **Model provider API keys** (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`,
  etc.) — standard secret hygiene: `.env` is git-ignored
  ([`.gitignore`](../.gitignore)) and Docker-ignored
  ([`.dockerignore`](../.dockerignore)), but rotate anything that leaks.
- **Tool/skill implementations you add.** `withSkillExecutionSpan` traces
  *that* a tool ran and *how long it took* — it does not validate or
  sanitize what the tool does. A DB-lookup or HTTP-call skill you write is
  exactly as safe as you make it (parameterized queries, allow-listed
  hosts, etc.) — the SDK has no visibility into that.
- **Prompt injection.** Nothing here defends against a user prompt trying
  to manipulate the agent into misusing a tool — that's a model/tool-design
  problem, out of scope for a telemetry/observability layer.
