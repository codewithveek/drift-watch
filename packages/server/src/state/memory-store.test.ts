import { describe, it, expect } from 'vitest';
import { MemoryStateStore } from './memory-store.js';
import type { Approval } from '@driftwatch/sdk';

function pendingApproval(id: string): Approval {
  return {
    id,
    action: 'pause_agent',
    severity: 'high',
    reasons: ['token spend spiked'],
    recommendedAction: 'pause and investigate',
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

describe('MemoryStateStore', () => {
  it('defaults to a running agent state', async () => {
    const store = new MemoryStateStore();
    const state = await store.getAgentState();
    expect(state.status).toBe('running');
    expect(state.activeVersion).toBe(1);
  });

  it('persists agent state changes', async () => {
    const store = new MemoryStateStore();
    await store.setAgentState({ status: 'paused', activeVersion: 2, updatedAt: Date.now() });
    expect((await store.getAgentState()).status).toBe('paused');
  });

  it('lists only pending approvals', async () => {
    const store = new MemoryStateStore();
    await store.createApproval(pendingApproval('a'));
    await store.createApproval(pendingApproval('b'));
    await store.resolveApproval('b', 'approved', 'console', 'console');
    const pending = await store.listPendingApprovals();
    expect(pending.map((p) => p.id)).toEqual(['a']);
  });

  it('resolves an approval exactly once (idempotency guard)', async () => {
    const store = new MemoryStateStore();
    await store.createApproval(pendingApproval('a'));
    const first = await store.resolveApproval('a', 'approved', 'u1', 'slack');
    const second = await store.resolveApproval('a', 'rejected', 'u2', 'telegram');
    expect(first?.status).toBe('approved');
    expect(first?.resolvedBy).toBe('u1');
    expect(second).toBeUndefined();
  });

  it('enforces cooldown windows', async () => {
    const store = new MemoryStateStore();
    expect(await store.checkAndSetCooldown('notify_slack', 10_000)).toBe(true);
    expect(await store.checkAndSetCooldown('notify_slack', 10_000)).toBe(false);
    expect(await store.checkAndSetCooldown('other', 10_000)).toBe(true);
  });

  it('caps and orders drift history newest-first', async () => {
    const store = new MemoryStateStore();
    for (let i = 0; i < 3; i += 1) {
      await store.recordDriftVerdict({
        id: `d${i}`,
        at: i,
        drift: true,
        severity: 'low',
        reasons: [],
        recommendedAction: '',
        baselineTokenSpend: 0,
        currentTokenSpend: 0,
      });
    }
    const history = await store.listDriftHistory(10);
    expect(history.map((h) => h.id)).toEqual(['d2', 'd1', 'd0']);
  });
});
