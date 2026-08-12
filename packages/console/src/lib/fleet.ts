import {
  client,
  type AgentDefinition,
  type AgentRuntimeState,
  type Approval,
  type DriftHistoryEntry,
  type ToolCallApproval,
} from '@/api';

export interface AgentSummary {
  definition: AgentDefinition;
  state: AgentRuntimeState;
  /** Control approvals awaiting a human, in full — the fleet queue renders these. */
  approvals: Approval[];
  /** Gated tool calls awaiting a human. Each is holding a live request open. */
  toolCalls: ToolCallApproval[];
  /** Convenience counts. Kept as fields because badges read them on every render. */
  pendingApprovals: number;
  pendingToolCalls: number;
  /** Newest first, as the server returns it. Drives the drift chart and risk window. */
  history: DriftHistoryEntry[];
  lastVerdict?: DriftHistoryEntry;
}

export interface FleetSummary {
  agents: AgentSummary[];
  /** Fleet-wide total, for the sidebar badge. */
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
 * It returns the approval and verdict RECORDS, not just their counts, because
 * the same four requests per agent already carry them: the fleet-wide
 * approvals queue and the overview's drift chart are then pure derivations of
 * this one load rather than a second round of fan-out.
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
        client.getApprovals(definition.id).then(
          (r) => r.approvals,
          () => [],
        ),
        client.getPendingToolCalls(definition.id).then(
          (r) => r.toolCalls,
          () => [],
        ),
        client.getDriftHistory(definition.id).then(
          (r) => r.history,
          () => [],
        ),
      ]);

      return {
        definition,
        state,
        approvals,
        toolCalls,
        pendingApprovals: approvals.length,
        pendingToolCalls: toolCalls.length,
        history,
        lastVerdict: history[0],
      };
    }),
  );

  return {
    agents: summaries,
    pendingCount: summaries.reduce((sum, a) => sum + a.pendingApprovals + a.pendingToolCalls, 0),
  };
}

/** Every drift verdict in the fleet, newest first — the overview's chart input. */
export function allVerdicts(fleet: FleetSummary): DriftHistoryEntry[] {
  return fleet.agents.flatMap((agent) => agent.history).sort((a, b) => b.at - a.at);
}
