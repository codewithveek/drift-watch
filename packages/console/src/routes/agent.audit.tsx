import { useRouteLoaderData } from 'react-router';
import { FileClock, ScrollText } from 'lucide-react';
import { client, type ActionLogEntry, type AuditEvent } from '@/api';
import { ActionOutcomeChart } from '@/components/activity-chart';
import { ActionLogTable } from '@/components/action-log-table';
import { AuditTable } from '@/components/audit-table';
import { EmptyState, SectionHeading } from '@/components/domain';

export interface AuditLoaderData {
  log: ActionLogEntry[];
  events: AuditEvent[];
}

/**
 * Two logs, deliberately: `log` is what Autopilot DID to this agent, `events`
 * is who CHANGED it. The audit fetch degrades to empty rather than failing the
 * page — an agent-scoped key can read its own audit slice, but the action log
 * is the older, more universally available of the two.
 */
export async function auditLoader({
  params,
}: {
  params: { agentId?: string };
}): Promise<AuditLoaderData> {
  const [{ log }, events] = await Promise.all([
    client.getActionLog(params.agentId!),
    client.getAuditEvents(params.agentId!).then(
      (response) => response.events,
      () => [] as AuditEvent[],
    ),
  ]);
  return { log, events };
}

export function AgentAuditPage() {
  const { log, events } = useRouteLoaderData('agent-audit') as AuditLoaderData;

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

      <SectionHeading
        title="Configuration changes"
        description="Who changed this agent — guardrails, tool policies, approvals resolved."
      />
      <AuditTable
        events={events}
        emptyState={
          <EmptyState icon={<FileClock className="size-5" />} title="No changes recorded">
            Editing this agent's guardrails or tool policies, resolving one of its approvals, or
            pausing it records an entry here naming the principal that did it.
          </EmptyState>
        }
      />
    </div>
  );
}
