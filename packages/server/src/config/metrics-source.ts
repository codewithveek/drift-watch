/**
 * Builds a MetricsQuerySource for detectBehavioralDrift, scoped to ONE agent.
 * Kept as its own file (rather than inlined at each call site) so the three
 * places that call detectBehavioralDrift — /agents/:agentId/drift, the CLI,
 * and the Autopilot scheduler — construct it identically.
 *
 * Returns undefined when the agent has no `serviceName` registered — that
 * agent is tracked for approvals/control only, and the caller (the scheduler,
 * or a route) is expected to skip drift detection for it rather than query
 * with no way to isolate its metrics from every other agent's.
 *
 * Swap PrometheusMetricsSource for your own MetricsQuerySource implementation
 * here if you're not running Prometheus/Mimir/Cortex/Thanos behind
 * OTEL_EXPORTER_OTLP_ENDPOINT.
 */
import {
  PrometheusMetricsSource,
  type AgentDefinition,
  type DriftDetectionConfig,
  type MetricsQuerySource,
} from '@driftwatch/sdk';

export function createMetricsQuerySourceFor(
  driftDetectionConfig: DriftDetectionConfig,
  agent: AgentDefinition,
): MetricsQuerySource | undefined {
  if (!agent.serviceName) return undefined;
  return new PrometheusMetricsSource({
    baseUrl: driftDetectionConfig.prometheusBaseUrl,
    bearerToken: driftDetectionConfig.prometheusBearerToken || undefined,
    extraLabelMatchers: { service_name: agent.serviceName },
  });
}
