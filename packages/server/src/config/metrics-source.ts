/**
 * Builds a MetricsQuerySource for detectBehavioralDrift, scoped to ONE agent.
 * Kept as its own file (rather than inlined at each call site) so the three
 * places that call detectBehavioralDrift — /agents/:agentId/drift, the CLI,
 * and the Autopilot scheduler — construct it identically.
 *
 * Filters by `agent_id` (this agent's registry id) as the PRIMARY label —
 * the only discriminator guaranteed unique regardless of deployment
 * topology, since a deployment can host multiple agents sharing one
 * process/OTel service.name. `service_name` is included as a secondary
 * matcher when set (cheap, harmless, useful for teams that do run agents as
 * separate deployments) but is no longer load-bearing for isolation.
 *
 * Returns undefined when `driftDetectionEnabled` is explicitly false — that
 * agent is tracked for approvals/control only, and the caller (the
 * scheduler, or a route) is expected to skip drift detection for it.
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
  if (agent.driftDetectionEnabled === false) return undefined;
  return new PrometheusMetricsSource({
    baseUrl: driftDetectionConfig.prometheusBaseUrl,
    bearerToken: driftDetectionConfig.prometheusBearerToken || undefined,
    extraLabelMatchers: {
      agent_id: agent.id,
      ...(agent.serviceName ? { service_name: agent.serviceName } : {}),
    },
  });
}
