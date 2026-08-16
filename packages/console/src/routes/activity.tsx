import { useRouteLoaderData } from 'react-router';
import { FileClock, ScrollText } from 'lucide-react';
import { client, type ActionLogEntry, type AuditEvent } from '@/api';
import { ActionOutcomeChart } from '@/components/activity-chart';
import { ActionLogTable } from '@/components/action-log-table';
import { AuditTable } from '@/components/audit-table';
import { EmptyState, SectionHeading } from '@/components/domain';

/** An action-log entry carries no agent identity, so the fleet view attaches it. */
export interface FleetActionEntry extends ActionLogEntry {
  agentId: string;
  agentName: string;
}

export interface ActivityLoaderData {
  entries: FleetActionEntry[];
  /** Fleet-wide audit trail. Empty for an agent-scoped key, which gets a 403. */
  events: AuditEvent[];
}

/**
 * Fleet-wide action log.
 *
 * Same N+1 fan-out as the fleet summary and for the same reason: there is no
 * fleet-wide log endpoint, and this is a display concern that does not justify
 * growing the server. One agent's log failing degrades to an empty list rather
 * than blanking the page — a deregistering agent must not hide everyone else's
 * history.
 */
export async function activityLoader(): Promise<ActivityLoaderData> {
  const { agents } = await client.getAgents();

  // Unlike the per-agent logs, this is ONE endpoint — the audit trail is a
  // single fleet-wide stream by design. It 403s for an agent-scoped key, which
  // degrades to an empty section rather than blanking the page.
  const auditEvents = client.getAuditEvents().then(
    (response) => response.events,
    () => [] as AuditEvent[],
  );

  const logs = await Promise.all(
    agents.map((agent) =>
      client.getActionLog(agent.id).then(
        ({ log }) => log.map((entry) => ({ ...entry, agentId: agent.id, agentName: agent.name })),
        () => [] as FleetActionEntry[],
      ),
    ),
  );

  return {
    entries: logs.flat().sort((a, b) => b.at - a.at),
    events: await auditEvents,
  };
}

export function ActivityPage() {
  const { entries, events } = useRouteLoaderData('activity') as ActivityLoaderData;

  return (
    <div className="space-y-6">
      <SectionHeading
        as="h1"
        title="Activity"
        description="Every control action across the fleet — executed, shadowed, or held."
      />

      <ActionOutcomeChart
        log={entries}
        empty={
          <EmptyState icon={<ScrollText className="size-5" />} title="No actions in this window">
            Pausing an agent, rolling one back, or approving a proposed action all produce an
            entry. Autopilot in shadow mode records what it would have done, too.
          </EmptyState>
        }
      />

      {/* Both tables carry a heading: the audit trail needs one to distinguish
          it from the action log, and without a matching one here the log reads
          as an unlabelled appendix to the chart above it. */}
      <SectionHeading
        title="Action log"
        description="What Autopilot did to each agent — executed, shadowed, or held for approval."
      />
      <ActionLogTable
        entries={entries}
        showAgent
        emptyState={
          <EmptyState icon={<ScrollText className="size-5" />} title="No actions recorded">
            Every control action across every agent lands here with who triggered it and through
            which channel. Pausing an agent or approving an action produces the first entry.
          </EmptyState>
        }
      />

      <SectionHeading
        title="Audit trail"
        description="Who changed the control plane — agents registered, policies edited, keys minted."
      />
      <AuditTable
        events={events}
        showAgent
        emptyState={
          <EmptyState icon={<FileClock className="size-5" />} title="Nothing recorded yet">
            Every control-plane change is appended here with the principal behind it: the root
            a signed-in user, a named API key, or a local dev request.
          </EmptyState>
        }
      />
    </div>
  );
}
