/**
 * Builds a MetricsQuerySource for detectBehavioralDrift, scoped to ONE agent.
 * Kept as its own file (rather than inlined at each call site) so the three
 * places that call detectBehavioralDrift — /agents/:agentId/drift, the CLI,
 * and the Autopilot scheduler — construct it identically.
 *
 * ## Which backend, and why the order
 *
 * Prometheus wins WHEN CONFIGURED. A deployment running one has strictly richer
 * data than DriftWatch's own summaries: every OTel metric at full resolution,
 * including from processes that never report runs to this control plane. Falling
 * back to SQL when Prometheus IS available would quietly downgrade those
 * deployments.
 *
 * Otherwise the deployment's own Postgres answers, from the run and tool-call
 * records the control plane already stores. That is what makes a two-container
 * deployment (app + database) a real option rather than a degraded one, and it
 * costs nothing to the deployments that do run Prometheus.
 *
 * With neither — a memory or Redis backend and no Prometheus — there is no
 * source at all and drift detection is skipped rather than silently reporting
 * zeros. A window of zeroes is indistinguishable from a genuinely idle agent,
 * and letting the judge see one would invent drift out of missing data.
 *
 * Filters by `agent_id` (this agent's registry id) as the PRIMARY label — the
 * only discriminator guaranteed unique regardless of deployment topology, since
 * a deployment can host multiple agents sharing one process/OTel service.name.
 * `service_name` is a secondary matcher when set.
 *
 * Returns undefined when `driftDetectionEnabled` is explicitly false — that
 * agent is tracked for approvals/control only.
 */
import {
  PrometheusMetricsSource,
  type AgentDefinition,
  type DriftDetectionConfig,
  type MetricsQuerySource,
  type StateStore,
} from '@driftwatch/sdk';
import { SqlMetricsSource } from '../state/sql-metrics-source.js';
import { supportsRunHistory } from '../state/runs.js';

/**
 * The default `PROMETHEUS_URL` a deployment never changed.
 *
 * Treated as "not configured": it is unreachable from inside a container, and
 * every query against it fails. Before the SQL backend existed that produced a
 * clear connection error; now it would silently prevent the working fallback
 * from ever being chosen, which is a far worse failure.
 */
const UNCONFIGURED_PROMETHEUS_URLS = ['http://localhost:9090', 'http://127.0.0.1:9090'];

function isPrometheusConfigured(baseUrl: string): boolean {
  return baseUrl.length > 0 && !UNCONFIGURED_PROMETHEUS_URLS.includes(baseUrl.replace(/\/+$/, ''));
}

export interface MetricsSourceOptions {
  /** Enables the Postgres-backed fallback. Omit to keep Prometheus-only behaviour. */
  store?: StateStore;
}

export function createMetricsQuerySourceFor(
  driftDetectionConfig: DriftDetectionConfig,
  agent: AgentDefinition,
  options: MetricsSourceOptions = {},
): MetricsQuerySource | undefined {
  if (agent.driftDetectionEnabled === false) return undefined;

  if (isPrometheusConfigured(driftDetectionConfig.prometheusBaseUrl)) {
    return new PrometheusMetricsSource({
      baseUrl: driftDetectionConfig.prometheusBaseUrl,
      bearerToken: driftDetectionConfig.prometheusBearerToken || undefined,
      extraLabelMatchers: {
        agent_id: agent.id,
        ...(agent.serviceName ? { service_name: agent.serviceName } : {}),
      },
    });
  }

  if (options.store && supportsRunHistory(options.store)) {
    return new SqlMetricsSource({ store: options.store, agentId: agent.id });
  }

  return undefined;
}
