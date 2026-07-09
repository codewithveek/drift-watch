/**
 * OTel bootstrap. This file MUST be loaded before any other application code
 * (via `node --import ./telemetry/otel.js`) so auto-instrumentation can patch
 * Fastify, http, etc. before they're required.
 *
 * Exports OTLP over HTTP/proto to the SigNoz collector.
 * Self-hosted SigNoz's OTel collector listens on:
 *   - 4318 (HTTP/proto)  <- we use this
 *   - 4317 (gRPC)
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

// When your service runs in the same docker-compose network as SigNoz,
// use the collector's service name. Locally, use localhost.
const OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: 'agent-drift-watch',
    [ATTR_SERVICE_VERSION]: '0.1.0',
    // custom attribute so you can filter this agent's traces in SigNoz
    'agent.kind': 'drift-watch',
  }),
  traceExporter: new OTLPTraceExporter({
    url: `${OTLP_ENDPOINT}/v1/traces`,
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${OTLP_ENDPOINT}/v1/metrics`,
    }),
    exportIntervalMillis: 10_000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs instrumentation is noisy; turn it off for a cleaner trace view
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
