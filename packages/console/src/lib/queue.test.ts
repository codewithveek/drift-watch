import { describe, it, expect } from 'vitest';
import { buildQueue, queueItemKey, sortQueue, type QueueItem } from './queue.js';
import type { FleetSummary } from './fleet.js';

const NOW = 1_800_000_000_000;

function summary(id: string, toolCalls: number[], approvals: number[]) {
  return {
    definition: { id, name: id.toUpperCase(), createdAt: 0 },
    state: { status: 'running', activeVersion: 1, updatedAt: 0 },
    toolCalls: toolCalls.map((expiresAt, i) => ({
      id: `${id}-tc-${i}`,
      agentId: id,
      tool: 'create_refund',
      status: 'pending',
      createdAt: NOW,
      expiresAt,
    })),
    approvals: approvals.map((expiresAt, i) => ({
      id: `${id}-ap-${i}`,
      agentId: id,
      action: 'pause',
      severity: 'high',
      reasons: [],
      recommendedAction: 'pause',
      status: 'pending',
      createdAt: NOW,
      expiresAt,
    })),
    pendingToolCalls: toolCalls.length,
    pendingApprovals: approvals.length,
    history: [],
  };
}

const fleet = (agents: unknown[]): FleetSummary =>
  ({ agents, pendingCount: 0 }) as unknown as FleetSummary;

describe('buildQueue', () => {
  it('interleaves both kinds by deadline, not by agent', () => {
    // The order you have to work the queue in is "what expires first", which
    // has nothing to do with which agent or which mechanism produced it.
    const queue = buildQueue(
      fleet([summary('alpha', [NOW + 9000], [NOW + 1000]), summary('beta', [NOW + 5000], [])]),
    );

    expect(queue.map((e) => e.item.expiresAt)).toEqual([NOW + 1000, NOW + 5000, NOW + 9000]);
    expect(queue.map((e) => e.kind)).toEqual(['approval', 'toolCall', 'toolCall']);
  });

  it('tags every entry with the agent it came from', () => {
    const queue = buildQueue(fleet([summary('alpha', [NOW + 1000], [])]));
    expect(queue[0].agent).toEqual({ id: 'alpha', name: 'ALPHA', status: 'running' });
  });

  it('is empty for a fleet with nothing pending', () => {
    expect(buildQueue(fleet([summary('alpha', [], [])]))).toEqual([]);
  });
});

describe('queueItemKey', () => {
  it('namespaces by kind, so the two id spaces cannot collide', () => {
    const shared = { agent: { id: 'a', name: 'A', status: 'running' as const } };
    const toolCall = { ...shared, kind: 'toolCall', item: { id: 'x' } } as unknown as QueueItem;
    const approval = { ...shared, kind: 'approval', item: { id: 'x' } } as unknown as QueueItem;
    expect(queueItemKey(toolCall)).not.toBe(queueItemKey(approval));
  });
});

describe('sortQueue', () => {
  it('does not mutate its input', () => {
    const input = [
      { kind: 'toolCall', agent: {}, item: { expiresAt: 2 } },
      { kind: 'toolCall', agent: {}, item: { expiresAt: 1 } },
    ] as unknown as QueueItem[];
    const sorted = sortQueue(input);
    expect(input[0].item.expiresAt).toBe(2);
    expect(sorted[0].item.expiresAt).toBe(1);
  });
});
