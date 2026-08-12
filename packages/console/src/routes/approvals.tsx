import { useMemo } from 'react';
import { useRouteLoaderData } from 'react-router';
import { CheckCircle2 } from 'lucide-react';
import { ApprovalQueue } from '@/components/approval-queue';
import { EmptyState, SectionHeading } from '@/components/domain';
import { buildQueue } from '@/lib/queue';
import type { FleetSummary } from '@/lib/fleet';

/**
 * The fleet-wide decision queue.
 *
 * No loader of its own: the root loader already fetches every agent's pending
 * approvals and gated tool calls to build the sidebar badge, so this page is a
 * pure derivation of data that is on the client anyway. Adding a loader here
 * would double the fan-out to show the same records twice.
 */
export function ApprovalsPage() {
  const fleet = useRouteLoaderData('root') as FleetSummary;
  const entries = useMemo(() => buildQueue(fleet), [fleet]);

  const blocking = entries.filter((entry) => entry.kind === 'toolCall').length;
  const controlActions = entries.length - blocking;

  return (
    <div>
      <SectionHeading
        as="h1"
        title="Approvals"
        description={
          entries.length === 0
            ? 'Nothing across the fleet is waiting on a human.'
            : `${blocking} gated tool ${blocking === 1 ? 'call' : 'calls'} and ${controlActions} control ${
                controlActions === 1 ? 'action' : 'actions'
              }, soonest deadline first.`
        }
      />

      <ApprovalQueue
        entries={entries}
        emptyState={
          <EmptyState icon={<CheckCircle2 className="size-5" />} title="Nothing awaiting a decision">
            Control actions proposed by Autopilot, and tool calls gated by an agent's policies,
            both land here. A gated tool call holds its agent's request open until you decide, so
            this queue is worth leaving open.
          </EmptyState>
        }
      />
    </div>
  );
}
