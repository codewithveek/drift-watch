import { describe, it, expect } from 'vitest';
import { bucketByTime, seriesTotals, CHART_RANGES } from './series.js';

const DAY = 86_400_000;
/** A fixed local-noon anchor, so day boundaries are unambiguous in any TZ. */
const NOW = new Date(2026, 7, 12, 12, 0, 0).getTime();

const KEYS = ['none', 'low', 'high'] as const;

interface Event {
  at: number;
  severity: string;
}

const bucket = (items: Event[], days = 7, bucketDays = 1) =>
  bucketByTime(items, {
    now: NOW,
    days,
    bucketDays,
    keys: KEYS,
    at: (e) => e.at,
    seriesKey: (e) => e.severity,
  });

describe('bucketByTime', () => {
  it('emits one dense bucket per day, including days with no events', () => {
    const buckets = bucket([{ at: NOW, severity: 'high' }]);
    expect(buckets).toHaveLength(7);
    // A quiet week must not compress to a single column; the x-axis would
    // then make an idle fleet look exactly like a busy one.
    expect(buckets.filter((b) => b.total === 0)).toHaveLength(6);
  });

  it('defines every series key on every bucket', () => {
    // Recharts renders a MISSING key as a gap in the stack rather than as
    // zero, which reads as absent data instead of "none happened".
    for (const b of bucket([])) {
      for (const key of KEYS) expect(b[key]).toBe(0);
    }
  });

  it('counts each event into the day it falls in', () => {
    const buckets = bucket([
      { at: NOW, severity: 'high' },
      { at: NOW - 30 * 60_000, severity: 'high' },
      { at: NOW - 2 * DAY, severity: 'low' },
    ]);
    const today = buckets.at(-1)!;
    expect(today.high).toBe(2);
    expect(today.total).toBe(2);
    expect(buckets.at(-3)!.low).toBe(1);
  });

  it('ignores events outside the window on either side', () => {
    const buckets = bucket([
      { at: NOW - 30 * DAY, severity: 'high' },
      { at: NOW + 5 * DAY, severity: 'high' },
    ]);
    expect(buckets.reduce((sum, b) => sum + b.total, 0)).toBe(0);
  });

  it('ignores a series key that was never declared', () => {
    // A server that grows a new severity must not silently inflate totals
    // against a chart that has no colour or legend entry for it.
    const buckets = bucket([{ at: NOW, severity: 'catastrophic' }]);
    expect(buckets.reduce((sum, b) => sum + b.total, 0)).toBe(0);
  });

  it('widens each bucket when bucketDays > 1', () => {
    const buckets = bucket(
      [
        { at: NOW, severity: 'high' },
        { at: NOW - 3 * DAY, severity: 'high' },
      ],
      91,
      7,
    );
    expect(buckets).toHaveLength(13);
    // Both fall inside the final 7-day bucket.
    expect(buckets.at(-1)!.high).toBe(2);
  });

  it('puts today in the last bucket rather than a trailing partial one', () => {
    const buckets = bucket([{ at: NOW, severity: 'none' }]);
    expect(buckets.at(-1)!.none).toBe(1);
  });
});

describe('seriesTotals', () => {
  it('sums each key across the window', () => {
    const buckets = bucket([
      { at: NOW, severity: 'high' },
      { at: NOW - DAY, severity: 'high' },
      { at: NOW - DAY, severity: 'low' },
    ]);
    expect(seriesTotals(buckets, KEYS)).toEqual({ none: 0, low: 1, high: 2 });
  });
});

describe('CHART_RANGES', () => {
  it('keeps every range under ~30 columns', () => {
    // A 90-day window bucketed daily would be 90 slivers a pixel wide.
    for (const range of CHART_RANGES) {
      expect(Math.ceil(range.days / range.bucketDays)).toBeLessThanOrEqual(31);
    }
  });
});
