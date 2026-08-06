/**
 * Builds this server's MetricsQuerySource for detectBehavioralDrift. Kept as
 * its own file (rather than inlined at each call site) so the three places
 * that call detectBehavioralDrift — /drift, the CLI, and the Autopilot
 * scheduler — construct it identically.
 *
 * Swap PrometheusMetricsSource for your own MetricsQuerySource implementation
 * here if you're not running Prometheus/Mimir/Cortex/Thanos behind
 * OTEL_EXPORTER_OTLP_ENDPOINT.
 */
import { PrometheusMetricsSource, type DriftDetectionConfig, type MetricsQuerySource } from '@driftwatch/sdk';

export function createMetricsQuerySource(
  driftDetectionConfig: DriftDetectionConfig,
): MetricsQuerySource {
  return new PrometheusMetricsSource({
    baseUrl: driftDetectionConfig.prometheusBaseUrl,
    bearerToken: driftDetectionConfig.prometheusBearerToken || undefined,
  });
}
