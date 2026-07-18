# Changelog

All notable changes to `@agentpulse/sdk` are documented here. This project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Added `TelemetryConfig.capturePayloads` (env: `OTEL_CAPTURE_PAYLOADS`) to
  let deployments opt out of attaching raw prompt text / tool-call inputs to
  spans, for cases where that content may carry PII or secrets.
- `bootstrapTelemetry` now accepts `{ registerShutdownHandlers: false }` so a
  host with its own shutdown sequence (e.g. an HTTP server that needs to
  drain in-flight requests first) can flush and exit in the right order
  instead of racing its own `SIGTERM`/`SIGINT` handler against the SDK's.

## [0.1.0] - 2026-07

- Initial extraction into a standalone, publishable package: typed config
  (`AgentPulseConfigSchema`), `runAgentTask`, `detectBehavioralDrift`,
  `bootstrapTelemetry`, and the AI SDK v7 → OTel telemetry bridge.
