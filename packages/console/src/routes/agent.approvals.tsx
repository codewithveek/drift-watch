import { useMemo } from 'react';
import { useRouteLoaderData } from 'react-router';
import { CheckCircle2 } from 'lucide-react';
import { client, type Approval, type ToolCallApproval } from '@/api';
import { ApprovalQueue } from '@/components/approval-queue';
import { EmptyState } from '@/components/domain';
import { sortQueue, type QueueItem } from '@/lib/queue';
import type { AgentLoaderData } from './agent';

export interface ApprovalsLoaderData {
  pendingApprovals: Approval[];
  pendingToolCalls: ToolCallApproval[];
}

export async function approvalsLoader({
  params,
}: {
  params: { agentId?: string };
}): Promise<ApprovalsLoaderData> {
  const agentId = params.agentId!;
  const [approvals, toolCalls] = await Promise.all([
    client.getApprovals(agentId),
    client.getPendingToolCalls(agentId),
  ]);
  return { pendingApprovals: approvals.approvals, pendingToolCalls: toolCalls.toolCalls };
}

/**
 * One agent's slice of the decision queue.
 *
 * Same component as the fleet-wide queue, with the agent column suppressed —
 * an operator who arrives here from the fleet page and one who arrives from an
 * agent should not have to learn two different review panels.
 */
export function AgentApprovalsPage() {
  const { definition, state } = useRouteLoaderData('agent') as AgentLoaderData;
  const { pendingApprovals, pendingToolCalls } = useRouteLoaderData(
    'agent-approvals',
  ) as ApprovalsLoaderData;

  const entries = useMemo<QueueItem[]>(() => {
    const agent = { id: definition.id, name: definition.name, status: state.agent.status };
    return sortQueue([
      ...pendingToolCalls.map((item): QueueItem => ({ kind: 'toolCall', agent, item })),
      ...pendingApprovals.map((item): QueueItem => ({ kind: 'approval', agent, item })),
    ]);
  }, [definition, state, pendingApprovals, pendingToolCalls]);

  return (
    <ApprovalQueue
      entries={entries}
      showAgent={false}
      emptyState={
        <EmptyState icon={<CheckCircle2 className="size-5" />} title="Nothing awaiting a decision">
          Control actions proposed by Autopilot, and tool calls gated by this agent's policies,
          both land here. A gated tool call holds the agent's request open until you decide, so
          this queue is worth watching.
        </EmptyState>
      }
    />
  );
}
