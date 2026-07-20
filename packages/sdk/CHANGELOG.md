# Changelog

All notable changes to `@driftwatch/sdk` are documented here. This project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-07-20

### SigNoz / OpenTelemetry

- **Metrics now export with delta temporality** (`temporalityPreference:
  DELTA`) instead of OpenTelemetry's default cumulative. SigNoz recommends
  delta, and it is what makes `detectBehavioralDrift` correct: the detector
  sums `agent.tool.calls` / `agent.tokens` and takes p95 of
  `agent.tool.duration` over time windows. Summing cumulative running totals
  produced meaningless, ever-growing numbers; summing deltas yields real
  "activity in the window".
- **Added `TelemetryConfig.otlpHeaders`** (env: `OTEL_EXPORTER_OTLP_HEADERS`,
  standard `k=v,k2=v2` form), attached to every OTLP export. This enables
  **SigNoz Cloud** — set `signoz-ingestion-key=<key>` and point
  `otlpEndpoint` at the regional ingest host. Self-hosted needs none.
- **`bootstrapTelemetry` now exports logs** over OTLP (`/v1/logs`) in addition
  to traces and metrics, and enables pino log↔trace correlation: Fastify log
  lines carry `trace_id`/`span_id` and are shipped to SigNoz, so you can jump
  from a span to the logs from that exact execution.
- Upgraded the OpenTelemetry stack to 2.x (`resources`/`sdk-metrics` 2.9,
  `sdk-node`/exporters/`sdk-logs` 0.220, `auto-instrumentations-node` 0.78)
  and switched from the deprecated `new Resource()` to `resourceFromAttributes()`.

### Earlier unreleased changes (now shipped in 0.2.0)

- Renamed the package from the working name `@agentpulse/sdk` to
  `@driftwatch/sdk`, and the exported config API from
  `AgentPulseConfigSchema`/`loadAgentPulseConfigFromEnv` to
  `DriftWatchConfigSchema`/`loadDriftWatchConfigFromEnv` — `agentpulse` was
  already taken on npm.
- Added `TelemetryConfig.capturePayloads` (env: `OTEL_CAPTURE_PAYLOADS`) to
  let deployments opt out of attaching raw prompt text / tool-call inputs to
  spans, for cases where that content may carry PII or secrets.
- `bootstrapTelemetry` now accepts `{ registerShutdownHandlers: false }` so a
  host with its own shutdown sequence (e.g. an HTTP server that needs to
  drain in-flight requests first) can flush and exit in the right order
  instead of racing its own `SIGTERM`/`SIGINT` handler against the SDK's.

## [0.1.0] - 2026-07

- Initial extraction into a standalone, publishable package: typed config
  (originally `AgentPulseConfigSchema`), `runAgentTask`, `detectBehavioralDrift`,
  `bootstrapTelemetry`, and the AI SDK v7 → OTel telemetry bridge.
