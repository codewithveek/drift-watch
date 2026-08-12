import { useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { cn } from '@/lib/utils';
import {
  CHART_RANGES,
  bucketByTime,
  seriesTotals,
  type ChartRangeValue,
} from '@/lib/series';
import type { ActionLogEntry, DriftHistoryEntry, DriftSeverity } from '@/api';
import { SEVERITY_COLOR } from '@/components/domain';

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS value, normally a token reference so the bar follows the theme. */
  color: string;
}

/**
 * A stacked activity chart over a selectable time window.
 *
 * Generic on purpose: drift verdicts by severity and control actions by
 * outcome are the same shape — dated events that belong to exactly one of a
 * small set of categories — and giving them one component means the two
 * charts in this console can never drift apart in axis treatment, tooltip
 * behaviour or empty state.
 */
export function StackedActivityCard<T>({
  title,
  items,
  at,
  seriesKey,
  series,
  empty,
  className,
  action,
}: {
  title: string;
  items: readonly T[];
  at: (item: T) => number;
  seriesKey: (item: T) => string;
  /** Stacking order, bottom to top. Put the most severe last so peaks read at the top. */
  series: readonly ChartSeries[];
  /** Shown instead of an axis-only chart when nothing falls in the window. */
  empty: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const [range, setRange] = useState<ChartRangeValue>('30');
  const selected = CHART_RANGES.find((r) => r.value === range) ?? CHART_RANGES[1];
  const keys = useMemo(() => series.map((s) => s.key), [series]);

  // `now` is captured per render rather than per tick: the buckets are days
  // wide, so re-deriving them on a timer would churn the chart for no visible
  // change. A route revalidation re-runs this with a fresh clock.
  const buckets = useMemo(
    () =>
      bucketByTime(items, {
        now: Date.now(),
        days: selected.days,
        bucketDays: selected.bucketDays,
        keys,
        at,
        seriesKey,
      }),
    [items, selected, keys, at, seriesKey],
  );

  const totals = seriesTotals(buckets, keys);
  const grandTotal = keys.reduce((sum, key) => sum + totals[key], 0);

  const config: ChartConfig = Object.fromEntries(
    series.map((s) => [s.key, { label: s.label, color: s.color }]),
  );

  return (
    <Card className={cn('gap-4', className)}>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <p className="mt-1 text-xs text-ink-3">
              <span className="tabular-nums">{grandTotal}</span>{' '}
              {grandTotal === 1 ? 'event' : 'events'} in the last {selected.label.toLowerCase()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {action}
            <ToggleGroup
              type="single"
              size="sm"
              spacing={1}
              value={range}
              onValueChange={(value) => value && setRange(value as ChartRangeValue)}
              aria-label="Chart range"
            >
              {CHART_RANGES.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  aria-label={`Last ${option.label}`}
                  className="h-7 rounded-full px-2.5 text-xs text-ink-3 data-[state=on]:bg-panel-2 data-[state=on]:text-ink"
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>

        {/* Legend doubles as the window's per-category totals — the number is
            what an operator wants, and a bare colour key would waste the row. */}
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5 text-xs text-ink-3">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
              <span className="font-medium tabular-nums text-ink-2">{totals[s.key]}</span>
            </li>
          ))}
        </ul>
      </CardHeader>

      <CardContent>
        {grandTotal === 0 ? (
          empty
        ) : (
          <ChartContainer config={config} className="aspect-auto h-56 w-full">
            <BarChart data={buckets} margin={{ top: 8, right: 4, bottom: 0, left: -16 }}>
              {/* Horizontal rules only, at the faintest step in the ramp: the
                  bars carry the comparison, the grid only helps read heights. */}
              <CartesianGrid vertical={false} stroke="var(--line)" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={10}
                minTickGap={24}
                interval="preserveStartEnd"
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={44}
                allowDecimals={false}
                tickMargin={4}
              />
              <ChartTooltip
                cursor={{ fill: 'var(--panel-2)' }}
                content={<ChartTooltipContent indicator="dot" />}
              />
              {series.map((s, index) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  stackId="a"
                  fill={`var(--color-${s.key})`}
                  // Only the top of the stack is rounded; rounding every
                  // segment would slice the column into separate pills.
                  radius={index === series.length - 1 ? [3, 3, 0, 0] : 0}
                  maxBarSize={28}
                />
              ))}
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Concrete configurations ──────────────────────────────────────────── */

const SEVERITY_SERIES: ChartSeries[] = (['none', 'low', 'medium', 'high'] as DriftSeverity[]).map(
  (severity) => ({
    key: severity,
    label: severity === 'none' ? 'No drift' : severity,
    color: SEVERITY_COLOR[severity],
  }),
);

export function DriftVerdictChart({
  history,
  className,
  empty,
  title = 'Drift verdicts',
}: {
  history: readonly DriftHistoryEntry[];
  className?: string;
  empty: ReactNode;
  title?: string;
}) {
  return (
    <StackedActivityCard
      title={title}
      className={className}
      items={history}
      at={verdictAt}
      seriesKey={verdictSeverity}
      series={SEVERITY_SERIES}
      empty={empty}
    />
  );
}

const verdictAt = (entry: DriftHistoryEntry) => entry.at;
const verdictSeverity = (entry: DriftHistoryEntry) => entry.severity;

/**
 * Outcome ordering runs benign -> alarming so a healthy agent's column is
 * mostly the muted base and anything worth noticing sits visibly on top.
 */
const OUTCOME_SERIES: ChartSeries[] = [
  { key: 'executed', label: 'Executed', color: 'var(--ok)' },
  { key: 'shadowed', label: 'Shadowed', color: 'var(--line-2)' },
  { key: 'skipped_cooldown', label: 'Cooldown', color: 'var(--info)' },
  { key: 'pending_approval', label: 'Awaited approval', color: 'var(--warn)' },
  { key: 'failed', label: 'Failed', color: 'var(--danger)' },
];

export function ActionOutcomeChart({
  log,
  className,
  empty,
}: {
  log: readonly ActionLogEntry[];
  className?: string;
  empty: ReactNode;
}) {
  return (
    <StackedActivityCard
      title="Control actions"
      className={className}
      items={log}
      at={actionAt}
      seriesKey={actionOutcome}
      series={OUTCOME_SERIES}
      empty={empty}
    />
  );
}

const actionAt = (entry: ActionLogEntry) => entry.at;
const actionOutcome = (entry: ActionLogEntry) => entry.outcome;
