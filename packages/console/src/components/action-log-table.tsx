import { useState } from 'react';
import { Link } from 'react-router';
import { ScrollText } from 'lucide-react';
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
import { OutcomeLabel } from '@/components/outcome';
import type { ActionLogEntry } from '@/api';

/** Entries carry agent identity only in the fleet-wide view. */
export interface LogRow extends ActionLogEntry {
  agentId?: string;
  agentName?: string;
}

/**
 * The action log, shared by the fleet-wide Activity page and one agent's Audit
 * tab. The only difference between them is a column, which is not enough to
 * justify two tables that would drift apart on the next change.
 *
 * Rendering is incremental. An unbounded audit trail is the kind of table that
 * looks fine against fixture data and then renders forty thousand pixels of
 * DOM against a real one — the log is append-only and never trimmed.
 */
const PAGE = 50;

export function ActionLogTable({
  entries,
  showAgent = false,
  emptyState,
}: {
  entries: LogRow[];
  showAgent?: boolean;
  emptyState?: React.ReactNode;
}) {
  const [visible, setVisible] = useState(PAGE);
  const now = Date.now();
  const rows = entries.slice(0, visible);
  const remaining = entries.length - rows.length;

  return (
    <div className="space-y-3">
      <Card className="overflow-hidden py-0">
        {entries.length === 0 ? (
          (emptyState ?? (
            <EmptyState icon={<ScrollText className="size-5" />} title="No actions recorded">
              Every control action — whether executed, shadowed, or skipped by a cooldown — is
              appended here with who triggered it and through which channel.
            </EmptyState>
          ))
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Action</TableHead>
                {showAgent && <TableHead>Agent</TableHead>}
                <TableHead>Outcome</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="hidden md:table-cell">Actor</TableHead>
                <TableHead className="pr-6 text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((entry) => (
                <TableRow key={`${entry.agentId ?? ''}:${entry.id}`}>
                  <TableCell className="py-2.5 pl-6 font-mono text-2xs text-ink">
                    {entry.action}
                  </TableCell>
                  {showAgent && (
                    <TableCell>
                      {entry.agentId ? (
                        <Link
                          to={`/agents/${entry.agentId}`}
                          className="rounded-sm text-xs text-ink-2 transition-colors hover:text-brand-bright"
                        >
                          {entry.agentName}
                        </Link>
                      ) : (
                        <span className="text-xs text-ink-3">—</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    <OutcomeLabel outcome={entry.outcome} />
                  </TableCell>
                  <TableCell className="max-w-md text-xs whitespace-normal text-ink-2">
                    {entry.reason}
                  </TableCell>
                  <TableCell className="hidden text-2xs text-ink-3 md:table-cell">
                    {entry.actor ?? '—'}
                    {entry.channel && <span> · {entry.channel}</span>}
                  </TableCell>
                  <TableCell className="pr-6 text-right text-2xs tabular-nums text-ink-3">
                    {timeAgo(entry.at, now)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {remaining > 0 && (
        <div className="flex items-center justify-center gap-3">
          <p className="text-2xs text-ink-3">
            Showing <span className="tabular-nums">{rows.length}</span> of{' '}
            <span className="tabular-nums">{entries.length}</span>
          </p>
          <Button variant="outline" size="sm" onClick={() => setVisible((n) => n + PAGE)}>
            Show {Math.min(PAGE, remaining)} more
          </Button>
        </div>
      )}
    </div>
  );
}
