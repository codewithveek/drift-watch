import { useState } from 'react';
import { useParams, useRevalidator, useRouteLoaderData } from 'react-router';
import { LineChart, Pause, Play, Radar, RotateCcw } from 'lucide-react';
import { client, type DriftHistoryEntry, type ToolMetadata } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DriftVerdictChart } from '@/components/activity-chart';
import { ToolAccessCard } from '@/components/tool-access';
import { EmptyState, Notice, SeverityBadge, Stat, timeAgo } from '@/components/domain';
import type { AgentLoaderData } from './agent';

export interface OverviewLoaderData {
  history: DriftHistoryEntry[];
  allTools: ToolMetadata[];
}

export async function overviewLoader({
  params,
}: {
  params: { agentId?: string };
}): Promise<OverviewLoaderData> {
  const [{ history }, { tools }] = await Promise.all([
    client.getDriftHistory(params.agentId!),
    // Tool metadata is what turns the access card from a list of names into a
    // list of consequences (destructive, sensitive fields).
    client.getTools(),
  ]);
  return { history, allTools: tools };
}

/** Verdicts shown in the feed. The chart above already covers the long tail. */
const FEED_LIMIT = 20;

export function AgentOverviewPage() {
  const { agentId } = useParams();
  const { state } = useRouteLoaderData('agent') as AgentLoaderData;
  const { history, allTools } = useRouteLoaderData('agent-overview') as OverviewLoaderData;
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  }

  const { guardrails, autopilot } = state;
  const paused = state.agent.status === 'paused';

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}

      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">Runtime</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Version" value={state.agent.activeVersion} />
            <Stat label="Model" value={state.agent.activeModel ?? 'default'} />
            <Stat label="Max steps" value={guardrails.maxSteps ?? '—'} hint="tool-use loop bound" />
            <Stat
              label="Token cap"
              value={guardrails.maxTokensPerTask === 0 ? 'off' : (guardrails.maxTokensPerTask ?? '—')}
              hint="per task"
            />
            <Stat
              label="Autopilot"
              value={autopilot.enabled ? autopilot.mode : 'off'}
              hint={
                autopilot.enabled ? `scans every ${autopilot.scanIntervalMs / 1000}s` : undefined
              }
            />
          </dl>

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button
              size="sm"
              variant={paused ? 'default' : 'outline'}
              disabled={busy !== null}
              onClick={() =>
                run('control', () => client.control(agentId!, paused ? 'resume' : 'pause'))
              }
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => run('rollback', () => client.control(agentId!, 'rollback'))}
            >
              <RotateCcw className="size-3.5" />
              Roll back
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => run('scan', () => client.scan(agentId!))}
            >
              <Radar className="size-3.5" />
              {busy === 'scan' ? 'Scanning…' : 'Scan now'}
            </Button>

            {state.agent.reason && (
              <p className="ml-auto truncate text-2xs text-ink-3">
                Last change: {state.agent.reason}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <DriftVerdictChart
          className="lg:col-span-2"
          history={history}
          empty={
            <EmptyState icon={<LineChart className="size-5" />} title="No verdicts in this window">
              Autopilot records a verdict on each scan, and “Scan now” above forces one. Verdicts
              compare a baseline window against the current one, so a few minutes of traffic are
              needed before the comparison means anything.
            </EmptyState>
          }
        />

        <ToolAccessCard
          toolNames={state.toolNames}
          toolPolicies={state.toolPolicies}
          allTools={allTools}
        />
      </div>

      <Card className="gap-0 py-0">
        <CardHeader className="py-4">
          <CardTitle className="text-base">Recent verdicts</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {history.length === 0 ? (
            <EmptyState icon={<LineChart className="size-5" />} title="No drift scans yet">
              Each scan appends a verdict here with the reasons behind it and what Autopilot
              recommends doing about it.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {history.slice(0, FEED_LIMIT).map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-start gap-3 px-6 py-3">
                  <SeverityBadge severity={entry.severity} />
                  <div className="min-w-0 flex-1">
                    {entry.reasons.length > 0 ? (
                      <ul className="space-y-0.5 text-xs text-ink-2">
                        {entry.reasons.map((reason, index) => (
                          <li key={index}>{reason}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-ink-3">
                        {entry.drift ? 'Drift detected' : 'No drift'}
                      </p>
                    )}
                    {/* `none` is the verdict engine's way of saying "do
                        nothing", not a recommendation worth a line of its own. */}
                    {entry.recommendedAction && entry.recommendedAction !== 'none' && (
                      <p className="mt-1 text-2xs text-ink-3">
                        Recommends {entry.recommendedAction.replace(/_/g, ' ')}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-2xs tabular-nums text-ink-3">
                    {timeAgo(entry.at, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
