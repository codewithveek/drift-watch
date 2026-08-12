import { useState } from 'react';
import { Link } from 'react-router';
import { FileClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, timeAgo } from '@/components/domain';
import { cn } from '@/lib/utils';
import type { AuditAction, AuditEvent } from '@/api';

/**
 * The audit trail — who changed what, and when.
 *
 * Deliberately a separate table from ActionLogTable even though both are
 * append-only time series: that one answers "what did Autopilot decide to do
 * to this agent", this one answers "which human or API key changed the
 * system". They share no columns beyond the timestamp, and merging them would
 * mean a table where half the cells are blank for half the rows.
 *
 * Same incremental rendering as ActionLogTable, for the same reason: the log
 * is capped server-side but 2000 rows is still far more DOM than anyone reads.
 */
const PAGE = 50;

/**
 * Grouped by consequence, not by noun. An operator scanning this table is
 * looking for the dangerous entries — key mints and policy changes — so those
 * are the ones that get a colour.
 */
const ACTION_TONE: Record<AuditAction, string> = {
  'apikey.create': 'text-warn-text',
  'apikey.revoke': 'text-warn-text',
  'policy.update': 'text-warn-text',
  'agent.create': 'text-ink-2',
  'agent.update': 'text-ink-2',
  'approval.resolve': 'text-ink-2',
  'toolcall.resolve': 'text-ink-2',
  'control.pause': 'text-ink-2',
  'control.resume': 'text-ink-2',
  'control.rollback': 'text-ink-2',
  'drift.scan': 'text-ink-3',
};

export function AuditTable({
  events,
  showAgent = false,
  emptyState,
}: {
  events: AuditEvent[];
  showAgent?: boolean;
  emptyState?: React.ReactNode;
}) {
  const [visible, setVisible] = useState(PAGE);
  const now = Date.now();
  const rows = events.slice(0, visible);
  const remaining = events.length - rows.length;

  return (
    <div className="space-y-3">
      <Card className="overflow-hidden py-0">
        {events.length === 0 ? (
          (emptyState ?? (
            <EmptyState icon={<FileClock className="size-5" />} title="Nothing recorded yet">
              Every control-plane change — an edited guardrail, a resolved approval, a minted API
              key — is appended here with the principal that made it.
            </EmptyState>
          ))
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">When</TableHead>
                  <TableHead className="w-40">Action</TableHead>
                  <TableHead className="w-40">Actor</TableHead>
                  {showAgent && <TableHead className="w-40">Agent</TableHead>}
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-2xs text-ink-3">
                      {timeAgo(event.at, now)}
                    </TableCell>
                    <TableCell>
                      <code className={cn('font-mono text-2xs', ACTION_TONE[event.action])}>
                        {event.action}
                      </code>
                    </TableCell>
                    <TableCell className="truncate text-xs text-ink-2">{event.actorLabel}</TableCell>
                    {showAgent && (
                      <TableCell className="text-xs">
                        {event.agentId ? (
                          <Link
                            to={`/agents/${event.agentId}`}
                            className="text-brand hover:underline"
                          >
                            {event.agentId}
                          </Link>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-xs text-ink-2">{event.summary}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {remaining > 0 && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setVisible((count) => count + PAGE)}>
            Show {Math.min(remaining, PAGE)} more
          </Button>
        </div>
      )}
    </div>
  );
}
