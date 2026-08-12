import { describe, it, expect } from 'vitest';
import { assessRisk, byRiskDescending } from './risk.js';
import type { AgentSummary } from './fleet.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    definition: { id: 'a', name: 'Agent', createdAt: 0 },
    state: { status: 'running', activeVersion: 1, updatedAt: 0 },
    approvals: [],
    toolCalls: [],
    pendingApprovals: 0,
    pendingToolCalls: 0,
    history: [],
    ...overrides,
  } as AgentSummary;
}

const verdict = (severity: string, at: number) =>
  ({ id: `${severity}-${at}`, at, drift: severity !== 'none', severity, reasons: [] }) as never;

describe('assessRisk', () => {
  it('is nominal for a healthy, idle agent', () => {
    const risk = assessRisk(agent(), NOW);
    expect(risk.score).toBe(0);
    expect(risk.level).toBe('low');
    expect(risk.signals).toEqual([]);
  });

  it('weights a blocking tool call above a control approval', () => {
    // A gated tool call is holding a live HTTP request open; a control action
    // is urgent but nothing is waiting on it.
    const blocking = assessRisk(agent({ pendingToolCalls: 1 }), NOW).score;
    const proposed = assessRisk(agent({ pendingApprovals: 1 }), NOW).score;
    expect(blocking).toBeGreaterThan(proposed);
  });

  it('only counts verdicts from the last 24 hours', () => {
    const stale = assessRisk(
      agent({ history: [verdict('high', NOW - 2 * DAY)] }),
      NOW,
    );
    expect(stale.score).toBe(0);

    const fresh = assessRisk(agent({ history: [verdict('high', NOW - 3600_000)] }), NOW);
    expect(fresh.score).toBeGreaterThan(0);
  });

  it('crosses to high once enough signals stack up', () => {
    const risk = assessRisk(agent({ pendingToolCalls: 2 }), NOW);
    expect(risk.level).toBe('high');
  });

  it('reports every contributing signal, heaviest first', () => {
    // The badge must never assert a level the UI cannot explain.
    const risk = assessRisk(
      agent({
        pendingApprovals: 1,
        pendingToolCalls: 1,
        state: { status: 'paused', activeVersion: 1, updatedAt: 0 },
      }),
      NOW,
    );
    expect(risk.signals.map((s) => s.weight)).toEqual([3, 2, 2]);
    expect(risk.signals[0].label).toMatch(/blocking a live request/);
    expect(risk.signals.reduce((sum, s) => sum + s.weight, 0)).toBe(risk.score);
  });

  it('pluralises signal labels', () => {
    expect(assessRisk(agent({ pendingToolCalls: 1 }), NOW).signals[0].label).toContain(
      '1 tool call ',
    );
    expect(assessRisk(agent({ pendingToolCalls: 2 }), NOW).signals[0].label).toContain(
      '2 tool calls ',
    );
  });

  it('treats paused as worse than throttled', () => {
    const paused = assessRisk(
      agent({ state: { status: 'paused', activeVersion: 1, updatedAt: 0 } }),
      NOW,
    );
    const throttled = assessRisk(
      agent({ state: { status: 'throttled', activeVersion: 1, updatedAt: 0 } }),
      NOW,
    );
    expect(paused.score).toBeGreaterThan(throttled.score);
  });
});

describe('byRiskDescending', () => {
  it('ranks the worst agent first and keeps ties in registration order', () => {
    const quietA = agent({ definition: { id: 'quiet-a', name: 'Quiet A', createdAt: 0 } });
    const quietB = agent({ definition: { id: 'quiet-b', name: 'Quiet B', createdAt: 1 } });
    const loud = agent({
      definition: { id: 'loud', name: 'Loud', createdAt: 2 },
      pendingToolCalls: 3,
    });

    const ranked = byRiskDescending([quietA, quietB, loud], NOW);
    expect(ranked.map((r) => r.agent.definition.id)).toEqual(['loud', 'quiet-a', 'quiet-b']);
  });
});
