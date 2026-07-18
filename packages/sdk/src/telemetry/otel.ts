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
import { setCapturePayloadsEnabled } from './capture-config.js';

export interface BootstrapTelemetryOptions {
  /**
   * Registers SIGTERM/SIGINT handlers that flush the SDK and call
   * `process.exit(0)`. Defaults to true, which is correct for the SDK used
   * standalone (no other shutdown work to sequence against). A host that has
   * its own shutdown sequence to run first — e.g. draining an HTTP server's
   * in-flight requests before the process exits — should pass `false` here
   * and call `sdk.shutdown()` itself at the right point. Two independent
   * `process.exit(0)` callers racing on the same signal is exactly the bug
   * this option exists to avoid: whichever resolves first kills the process,
   * possibly before the other has finished draining or flushing.
   */
  registerShutdownHandlers?: boolean;
}

/**
 * Starts the OTel Node SDK and registers the AI SDK v7 Telemetry
 * integration.
 *
 * AI SDK v7's `experimental_telemetry` only emits when an integration is
 * registered — without this call, `isEnabled: true` on a generateText/
 * generateObject call is inert: no gen_ai step spans, no token counts.
 *
 * Returns the started NodeSDK so callers can shut it down manually — either
 * because they passed `registerShutdownHandlers: false`, or because they
 * want finer control than the built-in signal handlers.
 */
export function bootstrapTelemetry(
  telemetryConfig: TelemetryConfig,
  options: BootstrapTelemetryOptions = {},
): NodeSDK {
  const { registerShutdownHandlers = true } = options;
  setCapturePayloadsEnabled(telemetryConfig.capturePayloads);

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: telemetryConfig.serviceName,
      [ATTR_SERVICE_VERSION]: telemetryConfig.serviceVersion,
      'agent.kind': 'driftwatch',
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

  if (registerShutdownHandlers) {
    const shutDownTelemetry = async (): Promise<void> => {
      try {
        await sdk.shutdown();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGTERM', shutDownTelemetry);
    process.on('SIGINT', shutDownTelemetry);
  }

  return sdk;
}
