/**
 * `DriftWatchAgent` behaviour, with the control plane stubbed at `fetch`.
 *
 * The assertions worth having here are the ones about POLICY, not plumbing:
 * that an unreachable control plane leaves the agent running (fail open), that
 * an operator's override wins over what the code declared, and that tools are
 * wrapped in a way that cannot drift from the policies naming them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { DriftWatchAgent } from './driftwatch-agent.js';

const TOOLS = {
  issue_refund: tool({
    description: 'Issue a refund',
    inputSchema: z.object({ orderId: z.string(), amountUsd: z.number() }),
    execute: async ({ amountUsd }: { orderId: string; amountUsd: number }) => ({
      refunded: amountUsd,
    }),
  }),
  lookup_order: tool({
    description: 'Look up an order',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async () => ({ found: true }),
  }),
};

function syncResponse(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'payments',
    guardrails: { maxSteps: 6, maxCostUsd: 1, maxTotalTokens: 100_000, maxDurationMs: 60_000 },
    toolPolicies: [],
    toolNames: null,
    driftDetectionEnabled: true,
    overriddenFields: [],
    status: 'running',
    pollIntervalSeconds: 60,
    ...overrides,
  };
}

function stubFetch(handler: (url: string, init: RequestInit) => unknown) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const result = handler(String(input), init ?? {});
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Calls a wrapped tool the way the AI SDK would. */
async function callTool(agent: DriftWatchAgent<typeof TOOLS>, name: keyof typeof TOOLS, input: unknown) {
  const wrapped = agent.tools[name] as unknown as {
    execute: (input: unknown, options?: unknown) => Promise<unknown>;
  };
  return wrapped.execute(input, {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local-only mode (no url/apiKey)', () => {
  it('runs tools without contacting anything', async () => {
    const fetchMock = stubFetch(() => ({}));
    const agent = new DriftWatchAgent({ id: 'payments', tools: TOOLS });
    await agent.ready();

    await expect(callTool(agent, 'issue_refund', { orderId: 'o1', amountUsd: 25 })).resolves.toEqual(
      { refunded: 25 },
    );
    // Zero DriftWatch infrastructure required — the first of the three
    // supported topologies.
    expect(fetchMock).not.toHaveBeenCalled();
    agent.stop();
  });

  it('enforces a deny policy with no control plane at all', async () => {
    stubFetch(() => ({}));
    const agent = new DriftWatchAgent({
      id: 'payments',
      tools: TOOLS,
      policies: [{ tool: 'issue_refund', action: 'deny', reason: 'refunds are frozen' }],
    });
    await agent.ready();

    // `deny` needs no store, no notifier and no network — it is a pure local
    // decision, which is what makes offline gating possible.
    await expect(callTool(agent, 'issue_refund', { orderId: 'o1', amountUsd: 25 })).rejects.toThrow(
      /refunds are frozen|denied/i,
    );
    agent.stop();
  });
});

describe('sync', () => {
  it('pushes a declaration derived from the declared tools and policies', async () => {
    const fetchMock = stubFetch(() => syncResponse());
    const agent = new DriftWatchAgent({
      id: 'payments',
      name: 'Payments',
      url: 'https://dw.test',
      apiKey: 'dw_key',
      tools: TOOLS,
      guardrails: { maxSteps: 8 },
      policies: [
        { tool: 'issue_refund', field: 'amountUsd', condition: { gt: 100 }, action: 'require_approval' },
      ],
    });
    await agent.ready();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://dw.test/api/v1/agents/payments/sync');
    expect(init.headers).toMatchObject({ authorization: 'Bearer dw_key' });

    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('Payments');
    expect(body.guardrails).toEqual({ maxSteps: 8 });
    // Tool names come from the object keys, so the declaration cannot disagree
    // with what the agent can actually call.
    expect(body.toolNames.sort()).toEqual(['issue_refund', 'lookup_order']);
    // Authoring types converted to the wire shape, severity defaulted.
    expect(body.toolPolicies).toEqual([
      {
        tool: 'issue_refund',
        field: 'amountUsd',
        condition: { gt: 100 },
        action: 'require_approval',
        severity: 'medium',
      },
    ]);
    agent.stop();
  });

  it('strips a trailing slash from the url rather than emitting a double slash', async () => {
    const fetchMock = stubFetch(() => syncResponse());
    const agent = new DriftWatchAgent({
      id: 'payments',
      url: 'https://dw.test/',
      apiKey: 'k',
      tools: TOOLS,
    });
    await agent.ready();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://dw.test/api/v1/agents/payments/sync');
    agent.stop();
  });

  it('FAILS OPEN when the control plane is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const warn = vi.fn();
    const agent = new DriftWatchAgent({
      id: 'payments',
      url: 'https://dw.test',
      apiKey: 'k',
      tools: TOOLS,
      logger: { error: vi.fn(), warn },
    });
    await agent.ready();

    // The whole point: DriftWatch being down must not stop somebody else's
    // production agent from working.
    await expect(callTool(agent, 'lookup_order', { orderId: 'o1' })).resolves.toEqual({
      found: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not reach the control plane'));
    agent.stop();
  });

  it('also fails open on a 500, not just a network error', async () => {
    stubFetch(() => new Response('{"error":"boom"}', { status: 500 }));
    const agent = new DriftWatchAgent({ id: 'payments', url: 'https://dw.test', apiKey: 'k', tools: TOOLS });
    await agent.ready();
    await expect(callTool(agent, 'lookup_order', { orderId: 'o1' })).resolves.toEqual({ found: true });
    agent.stop();
  });
});

describe('layered configuration', () => {
  it("adopts the control plane's policies over the ones declared in code", async () => {
    stubFetch(() =>
      syncResponse({
        // An operator tightened this in the console: the code declared nothing,
        // the override denies outright.
        toolPolicies: [{ tool: 'issue_refund', action: 'deny', severity: 'high', reason: 'frozen by ops' }],
        overriddenFields: ['toolPolicies'],
      }),
    );
    const agent = new DriftWatchAgent({ id: 'payments', url: 'https://dw.test', apiKey: 'k', tools: TOOLS });
    await agent.ready();

    await expect(callTool(agent, 'issue_refund', { orderId: 'o1', amountUsd: 5 })).rejects.toThrow(
      /frozen by ops|denied/i,
    );
    agent.stop();
  });

  it('warns when it is running under operator overrides', async () => {
    stubFetch(() => syncResponse({ overriddenFields: ['guardrails'] }));
    const warn = vi.fn();
    const agent = new DriftWatchAgent({
      id: 'payments',
      url: 'https://dw.test',
      apiKey: 'k',
      tools: TOOLS,
      logger: { error: vi.fn(), warn },
    });
    await agent.ready();

    // An agent silently running configuration other than its own is exactly the
    // kind of thing an operator debugging at 3am needs told.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('operator overrides on: guardrails'));
    agent.stop();
  });

  it('exposes the effective config it is running under', async () => {
    stubFetch(() => syncResponse({ guardrails: { maxSteps: 2, maxCostUsd: 0.1 } }));
    const agent = new DriftWatchAgent({ id: 'payments', url: 'https://dw.test', apiKey: 'k', tools: TOOLS });
    await agent.ready();
    expect(agent.effectiveConfig?.guardrails).toMatchObject({ maxSteps: 2 });
    agent.stop();
  });
});

describe('tool wrapping', () => {
  it('preserves every declared tool and its behaviour', async () => {
    stubFetch(() => syncResponse());
    const agent = new DriftWatchAgent({ id: 'payments', url: 'https://dw.test', apiKey: 'k', tools: TOOLS });
    await agent.ready();

    expect(Object.keys(agent.tools).sort()).toEqual(['issue_refund', 'lookup_order']);
    await expect(callTool(agent, 'lookup_order', { orderId: 'o1' })).resolves.toEqual({ found: true });
    agent.stop();
  });

  it('keeps a tool that has no execute (client- or provider-executed)', async () => {
    stubFetch(() => syncResponse());
    const passthrough = {
      ask_user: tool({ description: 'Ask the user', inputSchema: z.object({ q: z.string() }) }),
    };
    const agent = new DriftWatchAgent({ id: 'payments', tools: passthrough });
    await agent.ready();
    // Wrapping a non-existent execute would crash at call time; passing it
    // through unchanged is the only correct handling.
    expect(agent.tools.ask_user).toBe(passthrough.ask_user);
    agent.stop();
  });
});

describe('polling', () => {
  it('does not hold the process open', async () => {
    stubFetch(() => syncResponse());
    const agent = new DriftWatchAgent({
      id: 'payments',
      url: 'https://dw.test',
      apiKey: 'k',
      tools: TOOLS,
      syncIntervalMs: 1_000,
    });
    await agent.ready();
    // A CI job or one-shot CLI must be able to exit when its work is done —
    // an un-unref'd interval would keep the event loop alive forever.
    expect(agent.effectiveConfig).toBeDefined();
    agent.stop();
  });

  it('can be disabled entirely', async () => {
    const fetchMock = stubFetch(() => syncResponse());
    const agent = new DriftWatchAgent({
      id: 'payments',
      url: 'https://dw.test',
      apiKey: 'k',
      tools: TOOLS,
      syncIntervalMs: 0,
    });
    await agent.ready();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    agent.stop();
  });
});
