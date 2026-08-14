import { useMemo } from 'react';
import { Link, useRouteLoaderData } from 'react-router';
import { LineChart, ServerCog, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { DriftVerdictChart } from '@/components/activity-chart';
import { RegisterAgentDialog } from '@/components/register-agent-dialog';
import {
  EmptyState,
  MetricTile,
  RiskBadge,
  SectionHeading,
  StatusDot,
  STATUS_LABEL,
} from '@/components/domain';
import { allVerdicts } from '@/lib/fleet';
import { byRiskDescending } from '@/lib/risk';
import type { RootData } from '@/routes/root';

const DAY_MS = 86_400_000;

/* ── Page ─────────────────────────────────────────────────────────────── */

export function FleetPage() {
  const fleet = useRouteLoaderData('root') as RootData;
  const now = Date.now();

  const statusCounts = {
    running: fleet.agents.filter((a) => a.state.status === 'running').length,
    paused: fleet.agents.filter((a) => a.state.status === 'paused').length,
    throttled: fleet.agents.filter((a) => a.state.status === 'throttled').length,
  };

  const verdicts = useMemo(() => allVerdicts(fleet), [fleet]);
  const recent = verdicts.filter((entry) => now - entry.at <= DAY_MS);
  const recentHigh = recent.filter((entry) => entry.severity === 'high').length;
  const recentMedium = recent.filter((entry) => entry.severity === 'medium').length;

  const blocking = fleet.agents.reduce((sum, agent) => sum + agent.pendingToolCalls, 0);
  const ruleCount = fleet.agents.reduce(
    (sum, agent) => sum + (agent.definition.toolPolicies?.length ?? 0),
    0,
  );
  const ungated = fleet.agents.filter(
    (agent) => (agent.definition.toolPolicies?.length ?? 0) === 0,
  ).length;

  const ranked = useMemo(() => byRiskDescending(fleet.agents, now), [fleet, now]);
  const attention = ranked.filter((entry) => entry.risk.score > 0).slice(0, 6);

  if (fleet.agents.length === 0) return <FirstRun />;

  return (
    <div className="space-y-8">
      <section>
        <SectionHeading
          as="h1"
          title="Dashboard"
          description="Everything the control plane knows about the fleet right now."
        />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Registered agents"
            value={fleet.agents.length}
            to="/agents"
            footer={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {(['running', 'paused', 'throttled'] as const)
                  .filter((status) => statusCounts[status] > 0)
                  .map((status) => (
                    <span key={status} className="inline-flex items-center gap-1.5">
                      <StatusDot status={status} />
                      <span className="tabular-nums">{statusCounts[status]}</span>
                      {STATUS_LABEL[status].toLowerCase()}
                    </span>
                  ))}
              </span>
            }
          />

          <MetricTile
            label="Awaiting a decision"
            value={fleet.pendingCount}
            to="/approvals"
            emphasis={fleet.pendingCount > 0 ? 'warn' : 'neutral'}
            footer={
              blocking > 0 ? (
                <span className="inline-flex items-center rounded-full bg-warn/15 px-2 py-0.5 font-medium text-warn-text">
                  {blocking} blocking a live request
                </span>
              ) : fleet.pendingCount > 0 ? (
                'control actions only — nothing is blocked'
              ) : (
                'queue clear'
              )
            }
          />

          <MetricTile
            label="Drift verdicts, 24h"
            value={recent.length}
            emphasis={recentHigh > 0 ? 'danger' : 'neutral'}
            footer={
              recent.length === 0 ? (
                'no scans in the last day'
              ) : (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="tabular-nums">{recentHigh} high</span>
                  <span className="tabular-nums">{recentMedium} medium</span>
                  <span className="tabular-nums">
                    {recent.length - recentHigh - recentMedium} lower
                  </span>
                </span>
              )
            }
          />

          <MetricTile
            label="Tool-call rules in force"
            value={ruleCount}
            footer={
              ungated === 0
                ? 'every agent has at least one rule'
                : `${ungated} of ${fleet.agents.length} agents run ungated`
            }
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <DriftVerdictChart
          className="lg:col-span-2"
          history={verdicts}
          empty={
            <EmptyState icon={<LineChart className="size-5" />} title="No verdicts in this window">
              Autopilot records one verdict per scan. Widen the range, or run “Scan now” on an
              agent to force one.
            </EmptyState>
          }
        />

        <Card className="gap-0">
          <div className="px-6 pb-3">
            <h2 className="text-base font-semibold tracking-tight text-ink">Needs attention</h2>
            <p className="mt-1 text-xs text-ink-3">
              Ranked by what is blocking, paused, or drifting.
            </p>
          </div>
          {attention.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="size-5" />} title="Fleet is quiet">
              No agent has a pending decision, a recent high-severity verdict, or a paused runtime.
            </EmptyState>
          ) : (
            <ol className="divide-y divide-line border-t border-line">
              {attention.map(({ agent, risk }, index) => (
                <li key={agent.definition.id}>
                  <Link
                    to={`/agents/${agent.definition.id}`}
                    className="flex items-start gap-3 px-6 py-2.5 transition-colors hover:bg-panel-2/70"
                  >
                    <span className="mt-0.5 w-4 shrink-0 text-right text-2xs tabular-nums text-ink-3">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">
                          {agent.definition.name}
                        </span>
                        <RiskBadge level={risk.level} />
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink-3">
                        {risk.signals[0]?.label}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

    </div>
  );
}

/**
 * First run. A fleet with no agents has nothing to summarise, so the whole
 * bento would render as four zeroes and two empty cards — worse than useless,
 * because it looks like the console is broken rather than unused.
 */
function FirstRun() {
  return (
    <div className="space-y-4">
      <SectionHeading as="h1" title="Dashboard" />
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
