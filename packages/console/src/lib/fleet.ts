import {
  client,
  type AgentDefinition,
  type AgentRuntimeState,
  type DriftHistoryEntry,
} from '@/api';

export interface AgentSummary {
  definition: AgentDefinition;
  state: AgentRuntimeState;
  /** Control approvals + gated tool calls both awaiting a human. */
  pendingApprovals: number;
  pendingToolCalls: number;
  lastVerdict?: DriftHistoryEntry;
}

export interface FleetSummary {
  agents: AgentSummary[];
  /** Fleet-wide total, for the top-bar badge. */
  pendingCount: number;
}

/**
 * Builds the fleet view.
 *
 * This is deliberately an N+1 fan-out: there is no fleet-wide state or
 * approvals endpoint on the server, and we chose not to add one rather than
 * grow the backend for a display concern. Requests run concurrently and a
 * fleet is a handful of agents, so this is cheap in practice — but if fleets
 * ever get large, one `GET /fleet/summary` route replaces the whole function.
 *
 * A single agent failing (mid-deregistration, say) must not blank the entire
 * fleet view, so per-agent failures degrade to a sensible default instead of
 * rejecting.
 */
export async function loadFleetSummary(): Promise<FleetSummary> {
  const { agents } = await client.getAgents();

  const summaries = await Promise.all(
    agents.map(async (definition): Promise<AgentSummary> => {
      const [state, approvals, toolCalls, history] = await Promise.all([
        client.getState(definition.id).then(
          (r) => r.agent,
          () => ({ status: 'running', activeVersion: 1, updatedAt: 0 }) as AgentRuntimeState,
        ),
        client.getApprovals(definition.id).then((r) => r.approvals, () => []),
        client.getPendingToolCalls(definition.id).then((r) => r.toolCalls, () => []),
        client.getDriftHistory(definition.id).then((r) => r.history, () => []),
      ]);

      return {
        definition,
        state,
        pendingApprovals: approvals.length,
        pendingToolCalls: toolCalls.length,
        lastVerdict: history[0],
      };
    }),
  );

  return {
    agents: summaries,
    pendingCount: summaries.reduce((sum, a) => sum + a.pendingApprovals + a.pendingToolCalls, 0),
  };
}
