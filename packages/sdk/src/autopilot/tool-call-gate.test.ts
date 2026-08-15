import { describe, it, expect, vi } from 'vitest';
import { gateToolCall } from './tool-call-gate.js';
import type { ApprovalStatus, ToolCallApproval } from './types.js';
import { MemoryStateStore } from './memory-store.js';
import type { NotifierRegistry } from './notify-dispatch.js';
import type { ToolCallPolicyRule } from './tool-call-policy.js';

function rule(overrides: Partial<ToolCallPolicyRule> & Pick<ToolCallPolicyRule, 'tool' | 'action'>): ToolCallPolicyRule {
  return { condition: {}, severity: 'medium', ...overrides };
}

/**
 * A StateStore for the gate's tests, built ON TOP of MemoryStateStore rather
 * than hand-rolling every method.
 *
 * The previous version implemented the interface by hand and silently fell
 * behind it: `StateStore` grew eight API-key and audit methods and the mock kept
 * claiming to be one, which nothing caught because test files were excluded from
 * typecheck. Subclassing means it can never drift again — new interface methods
 * are inherited — and the mirror map below exists only so the assertions can
 * inspect resolved approvals too, which no listing method exposes. It is named
 * `seenToolCalls` rather than `approvals` because the base class already has a
 * private field by that name, and shadowing it is a type error.
 */
class FakeStore extends MemoryStateStore {
  readonly seenToolCalls = new Map<string, ToolCallApproval>();

  override async createToolCallApproval(approval: ToolCallApproval): Promise<void> {
    await super.createToolCallApproval(approval);
    this.seenToolCalls.set(approval.id, { ...approval });
  }

  override async resolveToolCallApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: string,
    channel: string,
  ): Promise<ToolCallApproval | undefined> {
    const resolved = await super.resolveToolCallApproval(id, status, resolvedBy, channel);
    if (resolved) this.seenToolCalls.set(id, resolved);
    return resolved;
  }
}

function fakeStore(): FakeStore {
  return new FakeStore();
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
    expect(store.seenToolCalls.size).toBe(0);
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
    expect(store.seenToolCalls.size).toBe(0);
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
    await vi.waitFor(() => expect(store.seenToolCalls.size).toBe(1));
    const [id] = store.seenToolCalls.keys();
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

    await vi.waitFor(() => expect(store.seenToolCalls.size).toBe(1));
    const [id] = store.seenToolCalls.keys();
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
    const [approval] = store.seenToolCalls.values();
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

  it('a deny-only policy needs no store and no notifiers at all', async () => {
    const result = await gateToolCall({
      tool: 'refund_payment',
      input: { amount: 50000 },
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', action: 'deny', reason: 'never auto-refund' })],
      // no store, no notifiers, no approval config
    });
    expect(result).toEqual({ allowed: false, reason: 'never auto-refund' });
  });

  it('an allow verdict needs no infrastructure either', async () => {
    const result = await gateToolCall({
      tool: 'get_weather',
      input: {},
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', action: 'deny' })],
    });
    expect(result).toEqual({ allowed: true });
  });

  it('fails CLOSED when require_approval fires but no store was provided', async () => {
    const result = await gateToolCall({
      tool: 'refund_payment',
      input: {},
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', action: 'require_approval' })],
    });
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain('no StateStore');
  });

  it('works with a store but no notifiers — the approval is still recorded and resolvable', async () => {
    const store = fakeStore();
    const gatePromise = gateToolCall({
      tool: 'refund_payment',
      input: {},
      agentId: 'agent-1',
      rules: [rule({ tool: 'refund_payment', action: 'require_approval' })],
      store,
      approvalTimeoutMs: 5000,
      pollIntervalMs: 10,
    });

    await vi.waitFor(() => expect(store.seenToolCalls.size).toBe(1));
    const [id] = store.seenToolCalls.keys();
    await store.resolveToolCallApproval(id, 'approved', 'console', 'console');
    expect(await gatePromise).toEqual({ allowed: true });
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
