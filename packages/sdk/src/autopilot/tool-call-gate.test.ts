import { describe, it, expect, vi } from 'vitest';
import { gateToolCall } from './tool-call-gate.js';
import type { StateStore, ToolCallApproval } from './types.js';
import type { NotifierRegistry } from './notify-dispatch.js';
import type { ToolCallPolicyRule } from './tool-call-policy.js';

function rule(overrides: Partial<ToolCallPolicyRule> & Pick<ToolCallPolicyRule, 'tool' | 'action'>): ToolCallPolicyRule {
  return { condition: {}, severity: 'medium', ...overrides };
}

/** A minimal in-memory StateStore stand-in — only the methods gateToolCall touches. */
function fakeStore(): StateStore & { approvals: Map<string, ToolCallApproval> } {
  const approvals = new Map<string, ToolCallApproval>();
  return {
    approvals,
    async upsertAgent() {},
    async getAgentDefinition() {
      return { id: 'agent-1', name: 'Agent One', createdAt: 0 };
    },
    async listAgents() {
      return [];
    },
    async getAgentState() {
      return { status: 'running', activeVersion: 1, updatedAt: 0 };
    },
    async setAgentState() {},
    async createApproval() {},
    async getApproval() {
      return undefined;
    },
    async listPendingApprovals() {
      return [];
    },
    async resolveApproval() {
      return undefined;
    },
    async createToolCallApproval(approval) {
      approvals.set(approval.id, { ...approval });
    },
    async getToolCallApproval(id) {
      const found = approvals.get(id);
      return found ? { ...found } : undefined;
    },
    async listPendingToolCallApprovals() {
      return Array.from(approvals.values()).filter((a) => a.status === 'pending');
    },
    async resolveToolCallApproval(id, status, resolvedBy, channel) {
      const found = approvals.get(id);
      if (!found || found.status !== 'pending') return undefined;
      const resolved = { ...found, status, resolvedBy, channel, resolvedAt: Date.now() };
      approvals.set(id, resolved);
      return { ...resolved };
    },
    async recordDriftVerdict() {},
    async listDriftHistory() {
      return [];
    },
    async recordAction() {},
    async listActionLog() {
      return [];
    },
    async checkAndSetCooldown() {
      return true;
    },
    async acquireLeaderLock() {
      return true;
    },
    async close() {},
  };
}

function fakeNotifiers(): NotifierRegistry & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    list: [
      {
        channel: 'fake',
        async notify(message) {
          sent.push(message);
        },
      },
    ],
  };
}

describe('gateToolCall', () => {
  it('allows immediately with no store/notifier calls when no rules are configured', async () => {
    const store = fakeStore();
    const notifiers = fakeNotifiers();
    const result = await gateToolCall({
      tool: 'get_weather',
      input: {},
      agentId: 'agent-1',
      rules: [],
      store,
      notifiers,
      approvalTimeoutMs: 1000,
      timeoutDecision: 'rejected',
    });
    expect(result).toEqual({ allowed: true });
    expect(store.approvals.size).toBe(0);
    expect(notifiers.sent).toHaveLength(0);
  });

  it('allows immediately when rules are configured but none match', async () => {
    const store = fakeStore();
    const result = await gateToolCall({
      tool: 'get_weather',
      input: {},
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', action: 'deny' })],
      store,
      notifiers: fakeNotifiers(),
      approvalTimeoutMs: 1000,
      timeoutDecision: 'rejected',
    });
    expect(result).toEqual({ allowed: true });
  });

  it('denies immediately with no store write for a deny rule', async () => {
    const store = fakeStore();
    const result = await gateToolCall({
      tool: 'refund_payment',
      input: { amount: 50000 },
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', action: 'deny', reason: 'never auto-refund' })],
      store,
      notifiers: fakeNotifiers(),
      approvalTimeoutMs: 1000,
      timeoutDecision: 'rejected',
    });
    expect(result).toEqual({ allowed: false, reason: 'never auto-refund' });
    expect(store.approvals.size).toBe(0);
  });

  it('require_approval creates a pending approval and notifies, then allows once approved', async () => {
    const store = fakeStore();
    const notifiers = fakeNotifiers();
    const gatePromise = gateToolCall({
      tool: 'refund_payment',
      input: { amount: 5000 },
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', field: 'amount', condition: { gt: 1000 }, action: 'require_approval' })],
      store,
      notifiers,
      approvalTimeoutMs: 5000,
      timeoutDecision: 'rejected',
      pollIntervalMs: 10,
    });

    // Wait for the approval to be created, then resolve it as approved.
    await vi.waitFor(() => expect(store.approvals.size).toBe(1));
    const [id] = store.approvals.keys();
    await store.resolveToolCallApproval(id, 'approved', 'console-user', 'console');

    expect(await gatePromise).toEqual({ allowed: true });
    expect(notifiers.sent).toHaveLength(1);
  });

  it('require_approval denies once rejected', async () => {
    const store = fakeStore();
    const gatePromise = gateToolCall({
      tool: 'refund_payment',
      input: { amount: 5000 },
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', action: 'require_approval' })],
      store,
      notifiers: fakeNotifiers(),
      approvalTimeoutMs: 5000,
      timeoutDecision: 'rejected',
      pollIntervalMs: 10,
    });

    await vi.waitFor(() => expect(store.approvals.size).toBe(1));
    const [id] = store.approvals.keys();
    await store.resolveToolCallApproval(id, 'rejected', 'console-user', 'console');

    const result = await gatePromise;
    expect(result.allowed).toBe(false);
  });

  it('self-resolves to timeoutDecision and denies when nothing resolves it in time', async () => {
    const store = fakeStore();
    const result = await gateToolCall({
      tool: 'refund_payment',
      input: {},
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', action: 'require_approval' })],
      store,
      notifiers: fakeNotifiers(),
      approvalTimeoutMs: 50,
      timeoutDecision: 'rejected',
      pollIntervalMs: 10,
    });
    expect(result.allowed).toBe(false);
    const [approval] = store.approvals.values();
    expect(approval.status).toBe('rejected');
    expect(approval.channel).toBe('timeout');
  });

  it('timeoutDecision "approved" allows the call through on timeout (fail-open, opt-in)', async () => {
    const store = fakeStore();
    const result = await gateToolCall({
      tool: 'refund_payment',
      input: {},
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', action: 'require_approval' })],
      store,
      notifiers: fakeNotifiers(),
      approvalTimeoutMs: 50,
      timeoutDecision: 'approved',
      pollIntervalMs: 10,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('returns promptly and denies when the abortSignal is already aborted', async () => {
    const store = fakeStore();
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const result = await gateToolCall({
      tool: 'refund_payment',
      input: {},
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', action: 'require_approval' })],
      store,
      notifiers: fakeNotifiers(),
      approvalTimeoutMs: 5000,
      timeoutDecision: 'rejected',
      pollIntervalMs: 10,
      abortSignal: controller.signal,
    });
    expect(result.allowed).toBe(false);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
