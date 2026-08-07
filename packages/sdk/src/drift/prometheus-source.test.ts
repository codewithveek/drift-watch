import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrometheusMetricsSource } from './prometheus-source.js';

function vectorResponse(result: Array<{ metric?: Record<string, string>; value: [number, string] }>) {
  return {
    status: 'success',
    data: { resultType: 'vector', result },
  };
}

describe('PrometheusMetricsSource', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a zeroed-out window when Prometheus has no series', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => vectorResponse([]),
      text: async () => '',
    });

    const source = new PrometheusMetricsSource({ baseUrl: 'http://localhost:9090' });
    const stats = await source.queryWindowStats({
      windowLabel: 'current',
      startTimeMs: 0,
      endTimeMs: 3_600_000,
    });

    expect(stats.totalCalls).toBe(0);
    expect(stats.errorRate).toBe(0);
    expect(stats.p95LatencyMs).toBe(0);
    expect(stats.tokenSpend).toBe(0);
    expect(stats.toolMix).toEqual({});
    expect(stats.windowLabel).toBe('current');
  });

  it('derives toolMix, errorRate, p95 latency and tokenSpend from the three PromQL queries', async () => {
    fetchMock.mockImplementation(async (url: URL) => {
      const query = url.searchParams.get('query') ?? '';
      if (query.includes('agent_tool_calls_total')) {
        return {
          ok: true,
          json: async () =>
            vectorResponse([
              { metric: { tool: 'get_weather', outcome: 'ok' }, value: [0, '60'] },
              { metric: { tool: 'get_weather', outcome: 'error' }, value: [0, '6'] },
              { metric: { tool: 'search_docs', outcome: 'ok' }, value: [0, '30'] },
              { metric: { tool: 'search_docs', outcome: 'error' }, value: [0, '4'] },
            ]),
        };
      }
      if (query.includes('histogram_quantile')) {
        return { ok: true, json: async () => vectorResponse([{ value: [0, '175'] }]) };
      }
      if (query.includes('agent_tokens_total')) {
        return { ok: true, json: async () => vectorResponse([{ value: [0, '15000'] }]) };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const source = new PrometheusMetricsSource({ baseUrl: 'http://localhost:9090' });
    const stats = await source.queryWindowStats({
      windowLabel: 'current',
      startTimeMs: 0,
      endTimeMs: 3_600_000,
    });

    expect(stats.totalCalls).toBe(100);
    expect(stats.errorRate).toBeCloseTo(0.1, 5);
    expect(stats.p95LatencyMs).toBe(175);
    expect(stats.tokenSpend).toBe(15000);
    expect(stats.toolMix.get_weather).toBeCloseTo(0.66, 2);
    expect(stats.toolMix.search_docs).toBeCloseTo(0.34, 2);
  });

  it('sends the bearer token and time range when configured', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => vectorResponse([]) });

    const source = new PrometheusMetricsSource({
      baseUrl: 'http://localhost:9090',
      bearerToken: 'secret-token',
    });
    await source.queryModelSwitchCount({ startTimeMs: 0, endTimeMs: 60_000 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect((url as URL).pathname).toBe('/api/v1/query');
    expect((url as URL).searchParams.get('query')).toContain('agent_model_switches_total');
    expect((url as URL).searchParams.get('time')).toBe('60');
    expect((init as RequestInit).headers).toEqual({ authorization: 'Bearer secret-token' });
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });

    const source = new PrometheusMetricsSource({ baseUrl: 'http://localhost:9090' });
    await expect(
      source.queryModelSwitchCount({ startTimeMs: 0, endTimeMs: 60_000 }),
    ).rejects.toThrow(/Prometheus query failed: 500/);
  });

  it('splices extraLabelMatchers into all four PromQL queries (per-agent filtering)', async () => {
    const seenQueries: string[] = [];
    fetchMock.mockImplementation(async (url: URL) => {
      seenQueries.push(url.searchParams.get('query') ?? '');
      return { ok: true, json: async () => vectorResponse([]) };
    });

    const source = new PrometheusMetricsSource({
      baseUrl: 'http://localhost:9090',
      extraLabelMatchers: { service_name: 'checkout-agent' },
    });
    await source.queryWindowStats({ windowLabel: 'current', startTimeMs: 0, endTimeMs: 3_600_000 });
    await source.queryModelSwitchCount({ startTimeMs: 0, endTimeMs: 3_600_000 });

    expect(seenQueries).toHaveLength(4);
    for (const query of seenQueries) {
      expect(query).toContain('{service_name="checkout-agent"}');
    }
    expect(seenQueries[0]).toBe(
      'sum by (tool, outcome) (increase(agent_tool_calls_total{service_name="checkout-agent"}[3600s]))',
    );
    expect(seenQueries[3]).toBe(
      'sum(increase(agent_model_switches_total{service_name="checkout-agent"}[3600s]))',
    );
  });

  it('escapes quotes/backslashes in matcher values', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => vectorResponse([]) });

    const source = new PrometheusMetricsSource({
      baseUrl: 'http://localhost:9090',
      extraLabelMatchers: { service_name: 'weird"name\\here' },
    });
    await source.queryModelSwitchCount({ startTimeMs: 0, endTimeMs: 60_000 });

    const query = fetchMock.mock.calls[0][0].searchParams.get('query');
    expect(query).toContain('service_name="weird\\"name\\\\here"');
  });

  it('omits the matcher clause entirely when extraLabelMatchers is unset', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => vectorResponse([]) });

    const source = new PrometheusMetricsSource({ baseUrl: 'http://localhost:9090' });
    await source.queryModelSwitchCount({ startTimeMs: 0, endTimeMs: 60_000 });

    const query = fetchMock.mock.calls[0][0].searchParams.get('query');
    expect(query).toBe('sum(increase(agent_model_switches_total[60s]))');
  });
});
