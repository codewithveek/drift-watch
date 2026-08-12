/**
 * Time-bucketing for the console's charts.
 *
 * Pure and `now`-injected so it can be tested without freezing the clock. The
 * two properties that matter and are easy to get wrong:
 *
 *  - Buckets are DENSE. A day with no events still emits a bucket with zeroes,
 *    otherwise the x-axis silently compresses quiet periods and a flat week
 *    looks identical to a busy one.
 *  - Every series key is present on every bucket. Recharts renders a missing
 *    key as a gap in a stack rather than as zero, which reads as missing data.
 */

const DAY_MS = 86_400_000;

export interface SeriesBucket {
  /** Bucket start, ms. */
  start: number;
  /** Axis label. */
  label: string;
  /** Sum across every series key — drives the "N in this window" summary. */
  total: number;
  /** One entry per requested key, always defined. */
  [seriesKey: string]: number | string;
}

export interface BucketOptions<T> {
  /** Upper edge of the window; the last bucket is the one containing it. */
  now: number;
  /** How far back the window reaches, in days. */
  days: number;
  /** Days per bucket. 1 = daily columns; 7 = weekly, for longer windows. */
  bucketDays?: number;
  /** Series keys, in stacking order. Emitted as 0 when nothing falls in a bucket. */
  keys: readonly string[];
  /** Timestamp accessor, ms. */
  at: (item: T) => number;
  /** Which series an item belongs to. A key outside `keys` is ignored. */
  seriesKey: (item: T) => string;
}

const startOfLocalDay = (ms: number): number => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const dayMonth = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function bucketByTime<T>(items: readonly T[], options: BucketOptions<T>): SeriesBucket[] {
  const { now, days, bucketDays = 1, keys, at, seriesKey } = options;
  const span = bucketDays * DAY_MS;
  const count = Math.max(1, Math.ceil(days / bucketDays));

  // Anchor on local midnight so "today" is a whole column rather than a partial
  // one that always looks like a drop-off at the right edge.
  const lastStart = startOfLocalDay(now) - (bucketDays - 1) * DAY_MS;
  const firstStart = lastStart - (count - 1) * span;

  const buckets: SeriesBucket[] = Array.from({ length: count }, (_, index) => {
    const start = firstStart + index * span;
    const bucket: SeriesBucket = { start, label: dayMonth.format(new Date(start)), total: 0 };
    for (const key of keys) bucket[key] = 0;
    return bucket;
  });

  for (const item of items) {
    const timestamp = at(item);
    const index = Math.floor((timestamp - firstStart) / span);
    if (index < 0 || index >= count) continue;

    const key = seriesKey(item);
    if (!keys.includes(key)) continue;

    const bucket = buckets[index];
    bucket[key] = (bucket[key] as number) + 1;
    bucket.total += 1;
  }

  return buckets;
}

/** Per-key totals over a set of buckets — the legend's counts. */
export function seriesTotals(
  buckets: readonly SeriesBucket[],
  keys: readonly string[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const key of keys) {
    totals[key] = buckets.reduce((sum, bucket) => sum + ((bucket[key] as number) ?? 0), 0);
  }
  return totals;
}

/**
 * The window options offered above a chart. `bucketDays` widens with the range
 * so a 90-day view is ~13 columns rather than 90 slivers a pixel wide.
 */
export const CHART_RANGES = [
  { value: '7', label: '7D', days: 7, bucketDays: 1 },
  { value: '30', label: '30D', days: 30, bucketDays: 1 },
  { value: '90', label: '90D', days: 91, bucketDays: 7 },
] as const;

export type ChartRangeValue = (typeof CHART_RANGES)[number]['value'];
