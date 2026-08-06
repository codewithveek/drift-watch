# Changelog

All notable changes to `@driftwatch/server` (the reference Fastify server) are
documented here. This project follows [Semantic Versioning](https://semver.org/).
This package is private and not published to npm — versions are for internal
release tracking.

## [Unreleased]

## [0.3.0] - 2026-07-20

- Telemetry now emits **logs** (with `trace_id`/`span_id` correlation on
  Fastify's pino logs) and **metrics with delta temporality**, and supports
  **SigNoz Cloud** via an ingestion key. Delivered by upgrading to
  `@driftwatch/sdk` 0.2.0 (OpenTelemetry 2.x).
- `.env.example`: documented `OTEL_EXPORTER_OTLP_HEADERS` (set
  `signoz-ingestion-key=<key>` for SigNoz Cloud; leave empty for self-hosted)
  and clarified that traces, metrics and logs all export to
  `<endpoint>/v1/{traces,metrics,logs}`.

## [0.2.0]

- Prior state: Fastify HTTP surface, demo skills (tools), bring-your-own
  model-client wiring, drift CLI, autopilot scheduler, and the React console
  served at `/console`.
