/**
 * OTel bootstrap. `bootstrapTelemetry` must be called before any other
 * application code runs (typically from a `node --import` preload script)
 * so auto-instrumentation can patch Fastify, http, etc. before they're
 * required. This module takes a typed `TelemetryConfig` rather than reading
 * `process.env` itself — the caller decides where that config comes from.
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
import type { TelemetryConfig } from '../config/schema.js';
import { AiSdkOtelIntegration } from './ai-sdk-otel.js';

/**
 * Starts the OTel Node SDK and registers the AI SDK v7 Telemetry
 * integration. Also wires SIGTERM/SIGINT to flush and exit.
 *
 * AI SDK v7's `experimental_telemetry` only emits when an integration is
 * registered — without this call, `isEnabled: true` on a generateText/
 * generateObject call is inert: no gen_ai step spans, no token counts.
 *
 * Returns the started NodeSDK so callers can shut it down manually if they
 * need finer control than the built-in signal handlers.
 */
export function bootstrapTelemetry(telemetryConfig: TelemetryConfig): NodeSDK {
  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: telemetryConfig.serviceName,
      [ATTR_SERVICE_VERSION]: telemetryConfig.serviceVersion,
      'agent.kind': 'agentpulse',
      'deployment.environment': telemetryConfig.environment,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${telemetryConfig.otlpEndpoint}/v1/traces`,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${telemetryConfig.otlpEndpoint}/v1/metrics`,
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

  return sdk;
}
