import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryStateStore } from './memory-store.js';

const addMock = vi.fn();

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    metrics: {
      ...actual.metrics,
      getMeter: () => ({
        createCounter: () => ({ add: addMock }),
      }),
    },
  };
});

const { executeControlAction } = await import('./actions.js');

beforeEach(() => {
  addMock.mockClear();
});

describe('executeControlAction switch_model — agent.model.switches counter labeling', () => {
  it('the required bugfix: the COUNTER carries agent_id, not just the span', async () => {
    const store = new MemoryStateStore();
    await store.setAgentState('agent-a', { status: 'running', activeVersion: 1, updatedAt: Date.now() });

    await executeControlAction(store, 'agent-a', 'switch_model', {
      reason: 'cost spike',
      targetModel: 'cheaper-model',
      serviceName: 'checkout-svc',
    });

    expect(addMock).toHaveBeenCalledWith(1, {
      from_model: 'default',
      to_model: 'cheaper-model',
      agent_id: 'agent-a',
      service_name: 'checkout-svc',
    });
  });

  it('two different agents switching models produce two differently-labeled counter increments', async () => {
    const store = new MemoryStateStore();
    await store.setAgentState('agent-a', { status: 'running', activeVersion: 1, updatedAt: Date.now() });
    await store.setAgentState('agent-b', { status: 'running', activeVersion: 1, updatedAt: Date.now() });

    await executeControlAction(store, 'agent-a', 'switch_model', {
      reason: 'r', targetModel: 'model-x',
    });
    await executeControlAction(store, 'agent-b', 'switch_model', {
      reason: 'r', targetModel: 'model-y',
    });

    expect(addMock).toHaveBeenCalledWith(1, expect.objectContaining({ agent_id: 'agent-a' }));
    expect(addMock).toHaveBeenCalledWith(1, expect.objectContaining({ agent_id: 'agent-b' }));
  });

  it('does not record a switch metric for a no-op switch (same model already active)', async () => {
    const store = new MemoryStateStore();
    await store.setAgentState('agent-a', {
      status: 'running',
      activeModel: 'already-this',
      activeVersion: 1,
      updatedAt: Date.now(),
    });

    await executeControlAction(store, 'agent-a', 'switch_model', {
      reason: 'r',
      targetModel: 'already-this',
    });

    expect(addMock).not.toHaveBeenCalled();
  });
});
