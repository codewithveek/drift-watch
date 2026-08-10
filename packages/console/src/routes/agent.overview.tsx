import { useState } from 'react';
import { useParams, useRevalidator, useRouteLoaderData } from 'react-router';
import { Pause, Play, RotateCcw, Radar, LineChart } from 'lucide-react';
import { client, type DriftHistoryEntry } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, SeverityBadge, Stat, timeAgo } from '@/components/domain';
import type { AgentLoaderData } from './agent';

export interface OverviewLoaderData {
  history: DriftHistoryEntry[];
}

export async function overviewLoader({
  params,
}: {
  params: { agentId?: string };
}): Promise<OverviewLoaderData> {
  const { history } = await client.getDriftHistory(params.agentId!);
  return { history };
}

export function AgentOverviewPage() {
  const { agentId } = useParams();
  const { state } = useRouteLoaderData('agent') as AgentLoaderData;
  const { history } = useRouteLoaderData('agent-overview') as OverviewLoaderData;
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
      {error && (
        <p className="rounded-md bg-danger/12 px-3 py-2 text-sm text-danger-text" role="alert">
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Version" value={state.agent.activeVersion} />
            <Stat label="Model" value={state.agent.activeModel ?? 'default'} />
            <Stat
              label="Token cap"
              value={guardrails.maxTokensPerTask === 0 ? 'off' : guardrails.maxTokensPerTask}
              hint="per task"
            />
            <Stat
              label="Autopilot"
              value={autopilot.enabled ? autopilot.mode : 'off'}
              hint={autopilot.enabled ? `scans every ${autopilot.scanIntervalMs / 1000}s` : undefined}
            />
          </dl>

          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
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
          </div>
          {state.agent.reason && (
            <p className="text-xs text-ink-3">Last change: {state.agent.reason}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Drift verdicts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {history.length === 0 ? (
            <EmptyState icon={<LineChart className="size-6" />} title="No drift scans yet">
              Autopilot records a verdict on each scan, and "Scan now" above forces one. Verdicts
              compare a baseline window against the current one, so a few minutes of traffic are
              needed before the comparison means anything.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {history.slice(0, 20).map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-start gap-3 px-6 py-3">
                  <SeverityBadge severity={entry.severity} />
                  <div className="min-w-0 flex-1">
                    {entry.reasons.length > 0 ? (
                      <ul className="list-inside list-disc text-xs text-ink-2">
                        {entry.reasons.map((reason, index) => (
                          <li key={index}>{reason}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-ink-3">
                        {entry.drift ? 'Drift detected' : 'No drift'}
                      </p>
                    )}
                    {entry.recommendedAction && (
                      <p className="mt-1 text-2xs text-ink-3">{entry.recommendedAction}</p>
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
