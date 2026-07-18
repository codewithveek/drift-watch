/**
 * Preload entrypoint: `node --import ./telemetry-bootstrap.js ./server.js`.
 * Must run before any other application code so OTel auto-instrumentation
 * can patch Fastify, http, etc. before they're required.
 *
 * This is the one place in the server package that loads telemetry config
 * from process.env — everything downstream (bootstrapTelemetry itself)
 * takes a typed TelemetryConfig, not an env lookup.
 *
 * Shutdown handlers are deliberately NOT registered here
 * (`registerShutdownHandlers: false`) — server.ts has its own SIGTERM/SIGINT
 * handler that closes Fastify (draining in-flight requests) before flushing
 * this SDK, so there's exactly one place that calls `process.exit`. See
 * `telemetrySdk` below, which server.ts reaches via a lazy `import()` at
 * shutdown time so this module's load order (and thus instrumentation
 * patching) is unaffected by anything server.ts does.
 */
import { loadDriftWatchConfigFromEnv, bootstrapTelemetry } from '@driftwatch/sdk';

const driftWatchConfig = loadDriftWatchConfigFromEnv();
export const telemetrySdk = bootstrapTelemetry(driftWatchConfig.telemetry, {
  registerShutdownHandlers: false,
});
