/**
 * Shared attribute-bag builder for "which agent produced this signal."
 * Conditionally includes each key so an absent value never emits an empty
 * label (which would blow up cardinality / muddy queries) — used at every
 * span/metric call site that needs to attribute output to a specific agent:
 * instrument.ts's tool-call counter/histogram, usage-tracking.ts's token
 * counter, and actions.ts's model-switch marker.
 */
export function buildAgentLabels(
  agentId?: string,
  serviceName?: string,
): Record<string, string> {
  return {
    ...(agentId ? { agent_id: agentId } : {}),
    ...(serviceName ? { service_name: serviceName } : {}),
  };
}
