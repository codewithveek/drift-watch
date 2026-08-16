import { useMemo, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Card } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import type { RunBucket } from '@/api';

/**
 * Run activity over time, from DriftWatch's own records.
 *
 * This is the chart that makes "no Grafana" true for the common case. It reads
 * per-run summaries the control plane stores rather than querying Prometheus,
 * so a two-container deployment still gets a usable picture of what its agents
 * have been doing.
 */

const CHART_CONFIG = {
  runs: { label: 'Runs', color: 'var(--color-brand)' },
  failed: { label: 'Failed', color: 'var(--color-danger)' },
} satisfies ChartConfig;

export interface RunActivityChartProps {
  buckets: RunBucket[];
  /** False when the backend cannot store run history (memory/Redis). */
  available: boolean;
  windowHours: number;
  empty: ReactNode;
  unavailable: ReactNode;
  className?: string;
}

export function RunActivityChart({
  buckets,
  available,
  windowHours,
  empty,
  unavailable,
  className,
}: RunActivityChartProps) {
  /*
   * Successful runs are plotted as (total - failed) rather than as the raw
   * total, so the two stacked areas sum to the total instead of the failure
   * band being drawn on top of and double-counting it.
   */
  const data = useMemo(
    () =>
      buckets.map((bucket) => ({
        at: bucket.at,
        succeeded: Math.max(0, bucket.runs - bucket.failed),
        failed: bucket.failed,
        totalTokens: bucket.totalTokens,
      })),
    [buckets],
  );

  const totals = useMemo(
    () =>
      buckets.reduce(
        (sum, bucket) => ({
          runs: sum.runs + bucket.runs,
          failed: sum.failed + bucket.failed,
          tokens: sum.tokens + bucket.totalTokens,
        }),
        { runs: 0, failed: 0, tokens: 0 },
      ),
    [buckets],
  );

  // A shorter window gets a time-of-day axis; a longer one gets dates, because
  // "14:00" repeated across seven days tells the reader nothing.
  const formatTick = (value: number) =>
    new Date(value).toLocaleString(undefined, {
      ...(windowHours <= 48
        ? { hour: '2-digit', minute: '2-digit' }
        : { month: 'short', day: 'numeric' }),
    });

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pb-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-ink">Run activity</h2>
          <p className="mt-1 text-xs text-ink-3">
            Last {windowHours}h, from this deployment's own records.
          </p>
        </div>
        {available && totals.runs > 0 && (
          <dl className="flex items-baseline gap-4 text-xs text-ink-3">
            <div>
              <dt className="inline">runs </dt>
              <dd className="inline font-medium tabular-nums text-ink">{totals.runs}</dd>
            </div>
            {totals.failed > 0 && (
              <div>
                <dt className="inline">failed </dt>
                <dd className="inline font-medium tabular-nums text-danger-text">
                  {totals.failed}
                </dd>
              </div>
            )}
            <div>
              <dt className="inline">tokens </dt>
              <dd className="inline font-medium tabular-nums text-ink">
                {totals.tokens.toLocaleString()}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {!available ? unavailable : data.length === 0 ? empty : (
        <ChartContainer config={CHART_CONFIG} className="h-56 w-full px-2 pb-2">
          <AreaChart data={data} margin={{ left: 4, right: 12, top: 4 }}>
            <CartesianGrid vertical={false} stroke="var(--color-line)" />
            <XAxis
              dataKey="at"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={formatTick}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={28}
              allowDecimals={false}
              tickMargin={4}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    new Date(Number(payload?.[0]?.payload?.at)).toLocaleString()
                  }
                />
              }
            />
            {/* Failed stacked UNDER succeeded so the failure band sits on the
                axis and its height is readable directly, rather than being an
                offset the eye has to subtract. */}
            <Area
              dataKey="failed"
              stackId="runs"
              type="monotone"
              stroke="var(--color-failed)"
              fill="var(--color-failed)"
              fillOpacity={0.35}
            />
            <Area
              dataKey="succeeded"
              stackId="runs"
              type="monotone"
              stroke="var(--color-runs)"
              fill="var(--color-runs)"
              fillOpacity={0.2}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </Card>
  );
}
