import { useMemo, useState } from 'react';
import { Link, useRouteLoaderData } from 'react-router';
import { ChevronRight, Search, ServerCog } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { RegisterAgentDialog } from '@/components/register-agent-dialog';
import {
  EmptyState,
  RiskBadge,
  SectionHeading,
  SeverityBadge,
  StatusDot,
  STATUS_LABEL,
  timeAgo,
} from '@/components/domain';
import type { AgentSummary } from '@/lib/fleet';
import { assessRisk, type RiskAssessment } from '@/lib/risk';
import { cn } from '@/lib/utils';
import type { RootData } from '@/routes/root';

/**
 * The agent inventory.
 *
 * Split out of the dashboard, which now answers "is anything wrong right now"
 * while this answers "what do we have, and which one do I want". The two were
 * one page because the sidebar carried the agent list; with that gone, the
 * inventory needs a home that can sort, filter and search — none of which a rail
 * can do, and all of which stop mattering at four agents and start mattering at
 * fifty.
 */

type FilterId = 'all' | 'attention' | 'running' | 'paused';

const FILTERS: { id: FilterId; label: string; match: (row: Row) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'attention', label: 'Needs attention', match: (row) => row.risk.level !== 'low' },
  { id: 'running', label: 'Running', match: (row) => row.agent.state.status === 'running' },
  { id: 'paused', label: 'Paused', match: (row) => row.agent.state.status !== 'running' },
];

interface Row {
  agent: AgentSummary;
  risk: RiskAssessment;
}

export function AgentsPage() {
  const fleet = useRouteLoaderData('root') as RootData;
  const now = Date.now();

  const [filter, setFilter] = useState<FilterId>('all');
  const [query, setQuery] = useState('');

  const rows: Row[] = useMemo(
    () => fleet.agents.map((agent) => ({ agent, risk: assessRisk(agent, now) })),
    [fleet, now],
  );

  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.id, rows.filter(f.match).length]),
  ) as Record<FilterId, number>;

  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (!FILTERS.find((f) => f.id === filter)!.match(row)) return false;
    if (!needle) return true;
    const { definition } = row.agent;
    return [definition.name, definition.id, definition.owner ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });

  if (fleet.agents.length === 0) {
    return (
      <div className="space-y-4">
        <SectionHeading as="h1" title="Agents" />
        <Card className="py-0">
          <EmptyState
            icon={<ServerCog className="size-5" />}
            title="No agents registered yet"
            action={<RegisterAgentDialog />}
          >
            A deployment registers its own agent on first run — or add one now. Each appears here
            with its live status, latest drift verdict, and anything waiting on your decision.
          </EmptyState>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        as="h1"
        title="Agents"
        description="Every agent registered with this control plane."
      >
        <RegisterAgentDialog />
      </SectionHeading>

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          value={filter}
          onValueChange={(value) => value && setFilter(value as FilterId)}
          aria-label="Filter agents"
        >
          {FILTERS.map((option) => (
            <ToggleGroupItem
              key={option.id}
              value={option.id}
              className="h-8 gap-1.5 rounded-full px-3 text-xs text-ink-3 data-[state=on]:bg-panel-2 data-[state=on]:text-ink"
            >
              {option.label}
              <span className="tabular-nums text-ink-3">{counts[option.id]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="relative ml-auto w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, id or owner"
            aria-label="Search agents"
            className="h-8 bg-panel pl-8 text-xs"
          />
        </div>
      </div>

      <Card className="overflow-hidden py-0">
        {visible.length === 0 ? (
          <EmptyState icon={<Search className="size-5" />} title="No agents match">
            {needle
              ? `Nothing matches “${query.trim()}” in this view.`
              : 'Every agent is filtered out by the current selection.'}
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              {/*
                Columns drop out by how much they help triage, not by source
                order: risk, status and the awaiting count are why an operator
                opens this table at all, so owner and last-verdict yield first.
                The alternative — one table scrolling sideways on a phone —
                hides exactly the columns that matter.
              */}
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Agent</TableHead>
                <TableHead className="hidden xl:table-cell">Owner</TableHead>
                <TableHead>Risk</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                <TableHead className="hidden lg:table-cell">Last verdict</TableHead>
                <TableHead className="text-right">Awaiting</TableHead>
                <TableHead className="hidden w-10 sm:table-cell" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ agent, risk }) => {
                const { definition, state, lastVerdict } = agent;
                const awaiting = agent.pendingApprovals + agent.pendingToolCalls;
                return (
                  <TableRow key={definition.id} className="group">
                    <TableCell className="py-2.5 pl-6">
                      <Link
                        to={`/agents/${definition.id}`}
                        className="block rounded-sm font-medium text-ink transition-colors hover:text-brand-bright"
                      >
                        {definition.name}
                        {/* The id is the widest thing in the row and, being
                            nowrap, it alone sets the table's minimum width —
                            enough to push the Awaiting column off a phone. */}
                        <span className="hidden font-mono text-2xs font-normal text-ink-3 sm:block">
                          {definition.id}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell className="hidden text-xs text-ink-2 xl:table-cell">
                      {definition.owner ?? <span className="text-ink-3">—</span>}
                    </TableCell>
                    <TableCell>
                      <RiskBadge level={risk.level} />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
                        <StatusDot status={state.status} ping />
                        {STATUS_LABEL[state.status]}
                      </span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {lastVerdict ? (
                        <span className="inline-flex items-center gap-2">
                          <SeverityBadge severity={lastVerdict.severity} />
                          <span className="text-2xs tabular-nums text-ink-3">
                            {timeAgo(lastVerdict.at, now)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-2xs text-ink-3">no scans yet</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {awaiting > 0 ? (
                        <Link
                          to={`/agents/${definition.id}/approvals`}
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums transition-colors',
                            agent.pendingToolCalls > 0
                              ? 'bg-warn/15 text-warn-text hover:bg-warn/25'
                              : 'bg-info/15 text-info-text hover:bg-info/25',
                          )}
                        >
                          {awaiting}
                        </Link>
                      ) : (
                        <span className="text-xs text-ink-3">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden pr-6 sm:table-cell">
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100"
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
