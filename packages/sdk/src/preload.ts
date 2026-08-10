/**
 * Zero-config telemetry preload:
 *
 *   node --env-file=.env --import @driftwatch/sdk/preload app.js
 *
 * This is exactly the `bootstrapTelemetry(loadDriftWatchConfigFromEnv().telemetry)`
 * call you would otherwise hand-write in your own file — nothing more. It
 * exists so you don't have to write that file, don't need `dotenv` (Node's
 * own `--env-file` covers it), and can't get the ordering wrong.
 *
 * ## Why a separate module at all
 *
 * ESM hoists every `import` in a file above that file's body, so calling
 * `bootstrapTelemetry()` "at the top" of your entry file still runs it AFTER
 * every imported module has been fully evaluated. Loading this module via
 * `--import` is the only way to run it genuinely first.
 *
 * How much that matters depends on what you use. DriftWatch's own signals are
 * order-independent by construction — `trace.getTracer()` returns a
 * ProxyTracer that upgrades when the provider registers, and the metric
 * instruments are created lazily for exactly this reason (see
 * telemetry/instrument.ts). `fetch`/undici HTTP spans are also
 * order-independent, since that instrumentation uses `diagnostics_channel`
 * rather than import-time patching. What genuinely needs this preload is
 * import-time-patched instrumentation: pino, Fastify, database drivers.
 *
 * ## When NOT to use this
 *
 * This reads configuration from environment variables only. If you build a
 * `DriftWatchConfig` in code, write your own one-line bootstrap module and
 * `--import` that instead:
 *
 *   // telemetry.js
 *   import { bootstrapTelemetry } from '@driftwatch/sdk';
 *   bootstrapTelemetry({ serviceName: 'my-agent', ... });
 *
 * Import order is the only thing that makes this file special — keep it free
 * of any other application imports.
 */
import { bootstrapTelemetry } from './telemetry/otel.js';
import { loadDriftWatchConfigFromEnv } from './config/schema.js';

bootstrapTelemetry(loadDriftWatchConfigFromEnv().telemetry);
