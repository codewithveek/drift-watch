import { useRouteLoaderData } from 'react-router';
import { ScrollText } from 'lucide-react';
import { client, type ActionLogEntry } from '@/api';
import { ActionOutcomeChart } from '@/components/activity-chart';
import { ActionLogTable } from '@/components/action-log-table';
import { EmptyState, SectionHeading } from '@/components/domain';

/** An action-log entry carries no agent identity, so the fleet view attaches it. */
export interface FleetActionEntry extends ActionLogEntry {
  agentId: string;
  agentName: string;
}

export interface ActivityLoaderData {
  entries: FleetActionEntry[];
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

  const logs = await Promise.all(
    agents.map((agent) =>
      client.getActionLog(agent.id).then(
        ({ log }) => log.map((entry) => ({ ...entry, agentId: agent.id, agentName: agent.name })),
        () => [] as FleetActionEntry[],
      ),
    ),
  );

  return { entries: logs.flat().sort((a, b) => b.at - a.at) };
}

export function ActivityPage() {
  const { entries } = useRouteLoaderData('activity') as ActivityLoaderData;

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
    </div>
  );
}
