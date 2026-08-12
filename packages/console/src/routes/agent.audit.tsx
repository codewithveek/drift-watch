import { useRouteLoaderData } from 'react-router';
import { ScrollText } from 'lucide-react';
import { client, type ActionLogEntry } from '@/api';
import { ActionOutcomeChart } from '@/components/activity-chart';
import { ActionLogTable } from '@/components/action-log-table';
import { EmptyState } from '@/components/domain';

export interface AuditLoaderData {
  log: ActionLogEntry[];
}

export async function auditLoader({
  params,
}: {
  params: { agentId?: string };
}): Promise<AuditLoaderData> {
  const { log } = await client.getActionLog(params.agentId!);
  return { log };
}

export function AgentAuditPage() {
  const { log } = useRouteLoaderData('agent-audit') as AuditLoaderData;

  return (
    <div className="space-y-4">
      <ActionOutcomeChart
        log={log}
        empty={
          <EmptyState icon={<ScrollText className="size-5" />} title="No actions in this window">
            Pausing this agent, rolling it back, or approving a proposed action all produce an
            entry. Autopilot in shadow mode records what it would have done, too.
          </EmptyState>
        }
      />

      <ActionLogTable
        entries={log}
        emptyState={
          <EmptyState icon={<ScrollText className="size-5" />} title="No actions recorded">
            Every control action — whether executed, shadowed, or skipped by a cooldown — is
            appended here with who triggered it and through which channel. Pausing this agent or
            approving an action will produce the first entry.
          </EmptyState>
        }
      />
    </div>
  );
}
