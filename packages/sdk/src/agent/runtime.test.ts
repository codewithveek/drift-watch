import { describe, it, expect, vi, beforeEach } from 'vitest';

const runAgentTaskMock = vi.fn();
vi.mock('./runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runner.js')>();
  return { ...actual, runAgentTask: (...args: unknown[]) => runAgentTaskMock(...args) };
});

const { createAgentRuntime } = await import('./runtime.js');
const { MemoryStateStore } = await import('../autopilot/memory-store.js');
const { DriftWatchConfigSchema } = await import('../config/schema.js');
const { ToolCallDeniedError } = await import('../telemetry/instrument.js');
import type { AgentDefinition } from '../autopilot/types.js';
import type { ModelClient } from '../model-client.js';

const config = DriftWatchConfigSchema.parse({});
const modelClient = 'fake' as unknown as ModelClient;

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'agent-1', name: 'Agent One', createdAt: 0, ...overrides };
}

beforeEach(() => {
  runAgentTaskMock.mockReset().mockResolvedValue({ responseText: 'ok' });
});

describe('createAgentRuntime — run()', () => {
  it('derives maxSteps + guardrails from the resolved config so the caller never re-spreads them', async () => {
    const runtime = createAgentRuntime({
      agent: agent({ guardrails: { maxTokensPerTask: 42, maxSteps: 3 } }),
      config,
    });
    await runtime.run({ prompt: 'hi', modelClient, tools: {} });

    const call = runAgentTaskMock.mock.calls[0][0];
    expect(call.agentId).toBe('agent-1');
    expect(call.maxSteps).toBe(3);
    expect(call.guardrails).toEqual({
      maxTokensPerTask: 42,
      maxCostUsd: config.agent.maxCostUsd,
      pricePer1kInput: config.agent.pricePer1kInput,
      pricePer1kOutput: config.agent.pricePer1kOutput,
      onExceed: config.agent.onExceed,
    });
  });

  it('a static agent needs no store — falls back to the agent\'s own values', async () => {
    const runtime = createAgentRuntime({ agent: agent(), config });
    await runtime.run({ prompt: 'hi', modelClient, tools: {} });
    expect(runAgentTaskMock.mock.calls[0][0].guardrails.maxTokensPerTask).toBe(
      config.agent.maxTokensPerTask,
    );
  });

  it('a FUNCTION agent source is re-resolved per run — a live edit lands on the next call', async () => {
    const store = new MemoryStateStore();
    await store.upsertAgent(agent());
    const runtime = createAgentRuntime({
      agent: async () => (await store.getAgentDefinition('agent-1'))!,
      config,
      store,
    });

    await runtime.run({ prompt: 'hi', modelClient, tools: {} });
    expect(runAgentTaskMock.mock.calls.at(-1)![0].guardrails.maxTokensPerTask).toBe(0);

    // Edit the stored definition — no restart, no re-construction of the runtime.
    await store.upsertAgent(agent({ guardrails: { maxTokensPerTask: 99 } }));

    await runtime.run({ prompt: 'hi', modelClient, tools: {} });
    expect(runAgentTaskMock.mock.calls.at(-1)![0].guardrails.maxTokensPerTask).toBe(99);
  });

  it('a STATIC agent source is deliberately frozen — later store edits do not apply', async () => {
    const store = new MemoryStateStore();
    const snapshot = agent();
    await store.upsertAgent(snapshot);
    const runtime = createAgentRuntime({ agent: snapshot, config, store });

    await store.upsertAgent(agent({ guardrails: { maxTokensPerTask: 99 } }));
    await runtime.run({ prompt: 'hi', modelClient, tools: {} });
    expect(runAgentTaskMock.mock.calls.at(-1)![0].guardrails.maxTokensPerTask).toBe(0);
  });

  it('resolves guardrailsSource through the store when one is configured', async () => {
    const store = new MemoryStateStore();
    await store.upsertAgent(agent({ id: 'base', guardrails: { maxTokensPerTask: 500 } }));
    const runtime = createAgentRuntime({
      agent: agent({ guardrailsSource: 'base' }),
      config,
      store,
    });
    await runtime.run({ prompt: 'hi', modelClient, tools: {} });
    expect(runAgentTaskMock.mock.calls[0][0].guardrails.maxTokensPerTask).toBe(500);
  });
});

describe('createAgentRuntime — skill()', () => {
  it('runs the underlying function when no policy applies', async () => {
    const runtime = createAgentRuntime({ agent: agent(), config });
    const execute = runtime.skill('get_weather', async (input: { city: string }) => ({
      city: input.city,
      tempC: 22,
    }));
    await expect(execute({ city: 'Lagos' })).resolves.toEqual({ city: 'Lagos', tempC: 22 });
  });

  it('denies via a deny rule — with no store or notifiers configured at all', async () => {
    const runtime = createAgentRuntime({
      agent: agent({
        toolPolicies: [
          { tool: 'issue_refund', action: 'deny', severity: 'high', reason: 'humans only' },
        ],
      }),
      config,
    });
    const body = vi.fn(async () => ({ refunded: true }));
    const execute = runtime.skill('issue_refund', body);

    await expect(execute({})).rejects.toThrow(ToolCallDeniedError);
    expect(body).not.toHaveBeenCalled();
  });

  it('the name given to skill() drives policy matching, so it cannot drift from the span name', async () => {
    const runtime = createAgentRuntime({
      agent: agent({
        toolPolicies: [{ tool: 'issue_refund', action: 'deny', severity: 'high' }],
      }),
      config,
    });
    // Same body, registered under a different name -> policy must not match.
    const other = runtime.skill('get_weather', async () => ({ ok: true }));
    await expect(other({})).resolves.toEqual({ ok: true });
  });

  it('a live agent source picks up a newly-added policy on the next call', async () => {
    const store = new MemoryStateStore();
    await store.upsertAgent(agent());
    const runtime = createAgentRuntime({
      agent: async () => (await store.getAgentDefinition('agent-1'))!,
      config,
      store,
    });
    const execute = runtime.skill('issue_refund', async () => ({ refunded: true }));

    await expect(execute({})).resolves.toEqual({ refunded: true });

    await store.upsertAgent(
      agent({ toolPolicies: [{ tool: 'issue_refund', action: 'deny', severity: 'high' }] }),
    );

    await expect(execute({})).rejects.toThrow(ToolCallDeniedError);
  });
});
