/**
 * Preload entrypoint: `node --import ./telemetry-bootstrap.js ./server.js`.
 * Must run before any other application code so OTel auto-instrumentation
 * can patch Fastify, http, etc. before they're required.
 *
 * This is the one place in the server package that loads telemetry config
 * from process.env — everything downstream (bootstrapTelemetry itself)
 * takes a typed TelemetryConfig, not an env lookup.
 */
import { loadAgentPulseConfigFromEnv, bootstrapTelemetry } from '@agentpulse/sdk';

const agentPulseConfig = loadAgentPulseConfigFromEnv();
bootstrapTelemetry(agentPulseConfig.telemetry);
