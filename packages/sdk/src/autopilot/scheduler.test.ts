import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { AutopilotScheduler } from './scheduler.js';
import { MemoryStateStore } from './memory-store.js';
import { ApprovalService } from './approval-service.js';
import { PolicyConfigSchema } from './policy.js';
import type { NotifierRegistry } from './notify-dispatch.js';
import type { MetricsQuerySource, WindowStats } from '../drift/metrics-source.js';
import type { ModelClient } from '../model-client.js';
import type { SchedulerLogger } from './scheduler.js';

const emptyNotifiers: NotifierRegistry = { list: [] };

const noopLogger: SchedulerLogger = { info: () => {}, error: () => {} };

const VALID_VERDICT_JSON = JSON.stringify({
  drift: false,
  severity: 'none',
  reasons: [],
  recommended_action: 'none',
});

function mockReply(text: string) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [],
  };
}

/** A fresh mock model good for exactly one judge call — matches one non-skipped agent per test. */
function makeModel(): ModelClient {
  return new MockLanguageModelV4({
    doGenerate: [mockReply(VALID_VERDICT_JSON)],
  }) as unknown as ModelClient;
}

class FakeMetricsQuerySource implements MetricsQuerySource {
  async queryWindowStats(options: { windowLabel: string }): Promise<WindowStats> {
    return {
      windowLabel: options.windowLabel,
      totalCalls: 10,
      errorRate: 0,
      p95LatencyMs: 100,
      tokenSpend: 100,
      toolMix: {},
    };
  }
  async queryModelSwitchCount(): Promise<number> {
    return 0;
  }
}

describe('AutopilotScheduler fleet loop', () => {
  it('skips drift detection for agents with no metrics source, still cycles agents that have one', async () => {
    const store = new MemoryStateStore();
    await store.upsertAgent({ id: 'agent-with-service', name: 'A', serviceName: 'svc-a', createdAt: 1 });
    await store.upsertAgent({ id: 'agent-without-service', name: 'B', createdAt: 2 });

    const approvalService = new ApprovalService({
      store,
      notifiers: emptyNotifiers,
      approvalTimeoutMs: 60_000,
      timeoutDecision: 'rejected',
    });
    const fakeSource = new FakeMetricsQuerySource();

    const scheduler = new AutopilotScheduler({
      store,
      notifiers: emptyNotifiers,
      approvalService,
      modelClient: makeModel(),
      policyConfig: PolicyConfigSchema.parse({}),
      metricsQuerySourceFor: (agent) => (agent.serviceName ? fakeSource : undefined),
      isDryRun: false,
      scanIntervalMs: 60_000,
      cooldownMs: 60_000,
      logger: noopLogger,
    });

    const { results } = await scheduler.runCycle('test');

    expect(results).toHaveLength(2);
    const withService = results.find((r) => r.agentId === 'agent-with-service');
    const withoutService = results.find((r) => r.agentId === 'agent-without-service');

    expect(withService?.skipped).toBeUndefined();
    expect(withService?.report).toBeDefined();
    expect(withoutService?.skipped).toBe('no-metrics-source');
    expect(withoutService?.report).toBeUndefined();

    expect(await store.listDriftHistory('agent-with-service', 10)).toHaveLength(1);
    expect(await store.listDriftHistory('agent-without-service', 10)).toHaveLength(0);

    approvalService.stop();
  });

  it('runCycleForAgent runs one agent without touching the rest of the fleet', async () => {
    const store = new MemoryStateStore();
    await store.upsertAgent({ id: 'agent-a', name: 'A', serviceName: 'svc-a', createdAt: 1 });
    await store.upsertAgent({ id: 'agent-b', name: 'B', serviceName: 'svc-b', createdAt: 2 });

    const approvalService = new ApprovalService({
      store,
      notifiers: emptyNotifiers,
      approvalTimeoutMs: 60_000,
      timeoutDecision: 'rejected',
    });
    const fakeSource = new FakeMetricsQuerySource();

    const scheduler = new AutopilotScheduler({
      store,
      notifiers: emptyNotifiers,
      approvalService,
      modelClient: makeModel(),
      policyConfig: PolicyConfigSchema.parse({}),
      metricsQuerySourceFor: () => fakeSource,
      isDryRun: false,
      scanIntervalMs: 60_000,
      cooldownMs: 60_000,
      logger: noopLogger,
    });

    const result = await scheduler.runCycleForAgent('agent-a', 'manual');
    expect(result.agentId).toBe('agent-a');
    expect(await store.listDriftHistory('agent-a', 10)).toHaveLength(1);
    expect(await store.listDriftHistory('agent-b', 10)).toHaveLength(0); // untouched

    approvalService.stop();
  });

  it('runCycleForAgent throws for an unregistered agent', async () => {
    const store = new MemoryStateStore();
    const approvalService = new ApprovalService({
      store,
      notifiers: emptyNotifiers,
      approvalTimeoutMs: 60_000,
      timeoutDecision: 'rejected',
    });

    const scheduler = new AutopilotScheduler({
      store,
      notifiers: emptyNotifiers,
      approvalService,
      modelClient: makeModel(),
      policyConfig: PolicyConfigSchema.parse({}),
      metricsQuerySourceFor: () => undefined,
      isDryRun: true,
      scanIntervalMs: 60_000,
      cooldownMs: 60_000,
      logger: noopLogger,
    });

    await expect(scheduler.runCycleForAgent('unknown', 'manual')).rejects.toThrow(/unknown agent/);
    approvalService.stop();
  });
});
