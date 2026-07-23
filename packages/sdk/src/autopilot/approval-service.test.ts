import { describe, it, expect, beforeEach } from 'vitest';
import type { ActionIntent } from './types.js';
import { MemoryStateStore } from './memory-store.js';
import { ApprovalService } from './approval-service.js';
import type { NotifierRegistry } from './notify-dispatch.js';

const emptyNotifiers: NotifierRegistry = { list: [] };

function controlIntent(): ActionIntent {
  return {
    type: 'pause_agent',
    category: 'control',
    severity: 'high',
    reason: 'error rate spiked',
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ApprovalService', () => {
  let store: MemoryStateStore;

  beforeEach(() => {
    store = new MemoryStateStore();
  });

  it('creates a pending approval and executes the control action once approved', async () => {
    const service = new ApprovalService({
      store,
      notifiers: emptyNotifiers,
      approvalTimeoutMs: 60_000,
      timeoutDecision: 'rejected',
    });

    const approval = await service.requestApproval(controlIntent());
    expect(approval.status).toBe('pending');
    expect(await store.listPendingApprovals()).toHaveLength(1);

    const resolved = await service.resolve(approval.id, 'approved', 'alice', 'slack');
    expect(resolved?.status).toBe('approved');
    expect(resolved?.resolvedBy).toBe('alice');
    expect(resolved?.channel).toBe('slack');

    // Approving pause_agent should have paused the monitored agent.
    const state = await store.getAgentState();
    expect(state.status).toBe('paused');
    service.stop();
  });

  it('is idempotent: a second resolve of the same approval is a no-op', async () => {
    const service = new ApprovalService({
      store,
      notifiers: emptyNotifiers,
      approvalTimeoutMs: 60_000,
      timeoutDecision: 'rejected',
    });

    const approval = await service.requestApproval(controlIntent());

    const first = await service.resolve(approval.id, 'approved', 'alice', 'slack');
    const second = await service.resolve(approval.id, 'rejected', 'bob', 'telegram');

    expect(first?.status).toBe('approved');
    expect(second).toBeUndefined(); // already resolved — the second caller loses the CAS
    service.stop();
  });

  it('does not run a control action when the decision is rejected', async () => {
    const service = new ApprovalService({
      store,
      notifiers: emptyNotifiers,
      approvalTimeoutMs: 60_000,
      timeoutDecision: 'rejected',
    });

    const approval = await service.requestApproval(controlIntent());
    await service.resolve(approval.id, 'rejected', 'alice', 'console');

    const state = await store.getAgentState();
    expect(state.status).toBe('running'); // unchanged
    service.stop();
  });

  it('falls back to the safe default decision when an approval times out', async () => {
    const service = new ApprovalService({
      store,
      notifiers: emptyNotifiers,
      approvalTimeoutMs: 20,
      timeoutDecision: 'rejected',
    });

    const approval = await service.requestApproval(controlIntent());
    await wait(60);

    const stored = await store.getApproval(approval.id);
    expect(stored?.status).toBe('rejected');
    expect(stored?.channel).toBe('timeout');
    // Safe default is reject, so the agent must not have been paused.
    expect((await store.getAgentState()).status).toBe('running');
    service.stop();
  });

  it('cancels the timeout once resolved, leaving the human decision intact', async () => {
    const service = new ApprovalService({
      store,
      notifiers: emptyNotifiers,
      approvalTimeoutMs: 20,
      timeoutDecision: 'rejected',
    });

    const approval = await service.requestApproval(controlIntent());
    await service.resolve(approval.id, 'approved', 'alice', 'console');
    await wait(60); // the timeout would have fired by now if not cancelled

    const stored = await store.getApproval(approval.id);
    expect(stored?.status).toBe('approved');
    expect(stored?.channel).toBe('console');
    service.stop();
  });
});
