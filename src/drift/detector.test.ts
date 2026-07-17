import { describe, it, expect } from 'vitest';
import { parseWindowStats } from './detector.js';

describe('parseWindowStats', () => {
  it('returns a zeroed-out window for empty results', () => {
    const windowStats = parseWindowStats('current', { data: { result: [] } });
    expect(windowStats.totalCalls).toBe(0);
    expect(windowStats.errorRate).toBe(0);
    expect(windowStats.p95LatencyMs).toBe(0);
    expect(windowStats.tokenSpend).toBe(0);
    expect(windowStats.toolMix).toEqual({});
    expect(windowStats.windowLabel).toBe('current');
  });

  it('derives toolMix, errorRate, p95 latency and tokenSpend from A/B/C series', () => {
    const windowStats = parseWindowStats('current', {
      data: {
        result: [
          {
            queryName: 'A',
            series: [
              { labels: { tool: 'get_weather', outcome: 'ok' }, values: [{ value: 60 }] },
              { labels: { tool: 'get_weather', outcome: 'error' }, values: [{ value: 6 }] },
              { labels: { tool: 'search_docs', outcome: 'ok' }, values: [{ value: 30 }] },
              { labels: { tool: 'search_docs', outcome: 'error' }, values: [{ value: 4 }] },
            ],
          },
          {
            queryName: 'B',
            series: [{ labels: {}, values: [{ value: 175 }] }],
          },
          {
            queryName: 'C',
            series: [
              { labels: { type: 'input' }, values: [{ value: 12000 }] },
              { labels: { type: 'output' }, values: [{ value: 3000 }] },
            ],
          },
        ],
      },
    });

    expect(windowStats.totalCalls).toBe(100);
    expect(windowStats.errorRate).toBeCloseTo(0.1, 5);
    expect(windowStats.p95LatencyMs).toBe(175);
    expect(windowStats.tokenSpend).toBe(15000);
    expect(windowStats.toolMix.get_weather).toBeCloseTo(0.66, 2);
    expect(windowStats.toolMix.search_docs).toBeCloseTo(0.34, 2);
  });

  it('coerces string values from the SigNoz payload', () => {
    const windowStats = parseWindowStats('current', {
      data: {
        result: [
          {
            queryName: 'A',
            series: [
              {
                labels: { tool: 'x', outcome: 'ok' },
                values: [{ value: '10' }, { value: '5' }],
              },
            ],
          },
        ],
      },
    });
    expect(windowStats.totalCalls).toBe(15);
  });
});
