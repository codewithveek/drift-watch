import { Link, useRouteLoaderData } from 'react-router';
import { ChevronRight, ServerCog } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card } from '@/components/ui/card';
import { EmptyState, SeverityBadge, StatusDot, STATUS_LABEL, timeAgo } from '@/components/domain';
import type { FleetSummary } from '@/lib/fleet';

export function FleetPage() {
  const fleet = useRouteLoaderData('root') as FleetSummary;
  const now = Date.now();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">Fleet</h1>
        <p className="text-sm text-ink-3">
          {fleet.agents.length} {fleet.agents.length === 1 ? 'agent' : 'agents'} registered
          {fleet.pendingCount > 0 && ` · ${fleet.pendingCount} awaiting a decision`}
        </p>
      </div>

      <Card className="overflow-hidden py-0">
        {fleet.agents.length === 0 ? (
          <EmptyState icon={<ServerCog className="size-6" />} title="No agents registered yet">
            An agent registers itself on first run, or you can add one with{' '}
            <code className="font-mono text-2xs">POST /agents</code>. Once registered it appears
            here with its live status, drift verdict, and anything waiting on you.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Last verdict</TableHead>
                  <TableHead className="text-right">Awaiting</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {fleet.agents.map(({ definition, state, pendingApprovals, pendingToolCalls, lastVerdict }) => {
                  const awaiting = pendingApprovals + pendingToolCalls;
                  return (
                    <TableRow key={definition.id} className="group">
                      <TableCell>
                        <Link
                          to={`/agents/${definition.id}`}
                          className="block rounded-sm font-medium text-ink hover:text-brand-bright"
                        >
                          {definition.name}
                          <span className="block font-mono text-2xs font-normal text-ink-3">
                            {definition.id}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
                          <StatusDot status={state.status} ping />
                          {STATUS_LABEL[state.status]}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-2xs text-ink-3">
                        {state.activeModel ?? 'default'}
                      </TableCell>
                      <TableCell>
                        {lastVerdict ? (
                          <span className="inline-flex items-center gap-2">
                            <SeverityBadge severity={lastVerdict.severity} />
                            <span className="text-2xs text-ink-3">
                              {timeAgo(lastVerdict.at, now)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-2xs text-ink-3">no scans yet</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {awaiting > 0 ? (
                          <Link
                            to={`/agents/${definition.id}/approvals`}
                            className="inline-flex items-center rounded-full bg-warn/12 px-2 py-0.5 text-xs font-medium text-warn-text hover:bg-warn/20"
                          >
                            {awaiting}
                          </Link>
                        ) : (
                          <span className="text-xs text-ink-3">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <ChevronRight className="size-4 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
