# Changelog

All notable changes to `@driftwatch/sdk` are documented here. This project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
