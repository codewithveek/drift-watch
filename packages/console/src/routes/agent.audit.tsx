import { useRouteLoaderData } from 'react-router';
import { ScrollText } from 'lucide-react';
import { client, type ActionLogEntry } from '@/api';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, timeAgo } from '@/components/domain';

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

const OUTCOME_CLASS: Record<string, string> = {
  executed: 'text-ok-text',
  shadowed: 'text-ink-3',
  pending_approval: 'text-warn-text',
  skipped_cooldown: 'text-ink-3',
  failed: 'text-danger-text',
};

export function AgentAuditPage() {
  const { log } = useRouteLoaderData('agent-audit') as AuditLoaderData;
  const now = Date.now();

  return (
    <Card className="overflow-hidden py-0">
      {log.length === 0 ? (
        <CardContent className="p-0">
          <EmptyState icon={<ScrollText className="size-6" />} title="No actions recorded">
            Every control action — whether executed, shadowed, or skipped by a cooldown — is
            appended here with who triggered it and through which channel. Pausing this agent or
            approving an action will produce the first entry.
          </EmptyState>
        </CardContent>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-mono text-2xs text-ink">{entry.action}</TableCell>
                  <TableCell
                    className={`text-2xs font-medium ${OUTCOME_CLASS[entry.outcome] ?? 'text-ink-2'}`}
                  >
                    {entry.outcome.replace(/_/g, ' ')}
                  </TableCell>
                  <TableCell className="max-w-md text-xs text-ink-2">{entry.reason}</TableCell>
                  <TableCell className="text-2xs text-ink-3">
                    {entry.actor ?? '—'}
                    {entry.channel && (
                      <span className="text-ink-3"> · {entry.channel}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-2xs tabular-nums text-ink-3">
                    {timeAgo(entry.at, now)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}
