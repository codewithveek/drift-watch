import { describe, it, expect } from 'vitest';
import { MemoryStateStore } from './memory-store.js';
import type { Approval } from './types.js';

function pendingApproval(id: string, agentId: string): Approval {
  return {
    id,
    agentId,
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
    const state = await store.getAgentState('agent-1');
    expect(state.status).toBe('running');
    expect(state.activeVersion).toBe(1);
  });

  it('persists agent state changes', async () => {
    const store = new MemoryStateStore();
    await store.setAgentState('agent-1', { status: 'paused', activeVersion: 2, updatedAt: Date.now() });
    expect((await store.getAgentState('agent-1')).status).toBe('paused');
  });

  it('lists only pending approvals', async () => {
    const store = new MemoryStateStore();
    await store.createApproval(pendingApproval('a', 'agent-1'));
    await store.createApproval(pendingApproval('b', 'agent-1'));
    await store.resolveApproval('b', 'approved', 'console', 'console');
    const pending = await store.listPendingApprovals('agent-1');
    expect(pending.map((p) => p.id)).toEqual(['a']);
  });

  it('resolves an approval exactly once (idempotency guard)', async () => {
    const store = new MemoryStateStore();
    await store.createApproval(pendingApproval('a', 'agent-1'));
    const first = await store.resolveApproval('a', 'approved', 'u1', 'slack');
    const second = await store.resolveApproval('a', 'rejected', 'u2', 'telegram');
    expect(first?.status).toBe('approved');
    expect(first?.resolvedBy).toBe('u1');
    expect(second).toBeUndefined();
  });

  it('enforces cooldown windows per agent', async () => {
    const store = new MemoryStateStore();
    expect(await store.checkAndSetCooldown('agent-1', 'notify_slack', 10_000)).toBe(true);
    expect(await store.checkAndSetCooldown('agent-1', 'notify_slack', 10_000)).toBe(false);
    expect(await store.checkAndSetCooldown('agent-1', 'other', 10_000)).toBe(true);
    // A different agent's cooldown is independent — an action storm on one
    // agent must not suppress a legitimate action for another.
    expect(await store.checkAndSetCooldown('agent-2', 'notify_slack', 10_000)).toBe(true);
  });

  it('caps and orders drift history newest-first', async () => {
    const store = new MemoryStateStore();
    for (let i = 0; i < 3; i += 1) {
      await store.recordDriftVerdict('agent-1', {
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
    const history = await store.listDriftHistory('agent-1', 10);
    expect(history.map((h) => h.id)).toEqual(['d2', 'd1', 'd0']);
  });

  describe('agent registry', () => {
    it('round-trips upsertAgent/getAgentDefinition/listAgents', async () => {
      const store = new MemoryStateStore();
      expect(await store.listAgents()).toEqual([]);

      await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
      await store.upsertAgent({
        id: 'agent-2',
        name: 'Agent Two',
        serviceName: 'agent-two-svc',
        createdAt: 2,
      });

      expect(await store.getAgentDefinition('agent-1')).toEqual({
        id: 'agent-1',
        name: 'Agent One',
        createdAt: 1,
      });
      expect(await store.getAgentDefinition('unknown')).toBeUndefined();

      const listed = await store.listAgents();
      expect(listed.map((a) => a.id)).toEqual(['agent-1', 'agent-2']);
    });

    it('upsertAgent is idempotent (same id overwrites, not duplicates)', async () => {
      const store = new MemoryStateStore();
      await store.upsertAgent({ id: 'agent-1', name: 'v1', createdAt: 1 });
      await store.upsertAgent({ id: 'agent-1', name: 'v2', createdAt: 1 });
      const listed = await store.listAgents();
      expect(listed).toHaveLength(1);
      expect(listed[0].name).toBe('v2');
    });
  });

  describe('cross-agent isolation', () => {
    it('keeps runtime state, drift history, and action log fully isolated between agents', async () => {
      const store = new MemoryStateStore();

      await store.setAgentState('agent-1', { status: 'paused', activeVersion: 1, updatedAt: 1 });
      await store.setAgentState('agent-2', { status: 'running', activeVersion: 1, updatedAt: 1 });
      expect((await store.getAgentState('agent-1')).status).toBe('paused');
      expect((await store.getAgentState('agent-2')).status).toBe('running');

      await store.recordDriftVerdict('agent-1', {
        id: 'd-agent-1',
        at: 1,
        drift: true,
        severity: 'high',
        reasons: [],
        recommendedAction: '',
        baselineTokenSpend: 0,
        currentTokenSpend: 0,
      });
      expect((await store.listDriftHistory('agent-1', 10)).map((e) => e.id)).toEqual(['d-agent-1']);
      expect(await store.listDriftHistory('agent-2', 10)).toEqual([]);

      await store.recordAction('agent-1', {
        id: 'a-agent-1',
        at: 1,
        action: 'pause_agent',
        category: 'control',
        outcome: 'executed',
        reason: 'test',
      });
      expect((await store.listActionLog('agent-1', 10)).map((e) => e.id)).toEqual(['a-agent-1']);
      expect(await store.listActionLog('agent-2', 10)).toEqual([]);
    });

    it('keeps pending approvals isolated between agents', async () => {
      const store = new MemoryStateStore();
      await store.createApproval(pendingApproval('a1', 'agent-1'));
      await store.createApproval(pendingApproval('a2', 'agent-2'));

      expect((await store.listPendingApprovals('agent-1')).map((a) => a.id)).toEqual(['a1']);
      expect((await store.listPendingApprovals('agent-2')).map((a) => a.id)).toEqual(['a2']);
    });
  });

  describe('leader lock', () => {
    it('stays global, not per-agent — acquiring it once blocks any subsequent caller regardless of agent context', async () => {
      const store = new MemoryStateStore();
      expect(await store.acquireLeaderLock('scheduler:leader', 10_000)).toBe(true);
      // A second "tick" (which has no agent context at all — the lock guards
      // the whole fleet cycle, not one agent) must be blocked.
      expect(await store.acquireLeaderLock('scheduler:leader', 10_000)).toBe(false);
    });
  });
});
