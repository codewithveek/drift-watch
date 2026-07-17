/**
 * OTel bootstrap. Must load before any other application code
 * (via `node --import ./telemetry/otel.js`) so auto-instrumentation can patch
 * Fastify, http, etc. before they're required.
 *
 * Exports OTLP over HTTP/proto. Self-hosted SigNoz's collector listens on
 * 4318 (HTTP/proto) and 4317 (gRPC); we use HTTP.
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
import { registerTelemetry } from 'ai';
import { AiSdkOtelIntegration } from './ai-sdk-otel.js';

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'agentpulse';

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
    'agent.kind': 'agentpulse',
    'deployment.environment': process.env.NODE_ENV ?? 'development',
  }),
  traceExporter: new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${otlpEndpoint}/v1/metrics`,
    }),
    exportIntervalMillis: 10_000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
});

sdk.start();

// AI SDK v7's `experimental_telemetry` only emits when an integration is
// registered. Without this the LLM step spans + token counts never reach
// SigNoz, and the drift detector's "token spend" delta is dead.
registerTelemetry(new AiSdkOtelIntegration());

const shutDownTelemetry = async (): Promise<void> => {
  try {
    await sdk.shutdown();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutDownTelemetry);
process.on('SIGINT', shutDownTelemetry);
