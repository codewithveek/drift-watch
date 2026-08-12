import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadFleetSummary } from './fleet.js';

/**
 * The fleet summary is an N+1 fan-out over per-agent endpoints (there is no
 * fleet-wide route on the server). These cover the two things that actually
 * matter about it: the aggregation is right, and ONE broken agent cannot blank
 * the whole fleet view.
 */

const AGENTS = [
  { id: 'agent-1', name: 'Agent One', createdAt: 1 },
  { id: 'agent-2', name: 'Agent Two', createdAt: 2 },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Routes a request to a canned body based on its path. */
function mockFetch(handler: (path: string) => unknown | Promise<unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : input.toString();
    const body = await handler(path);
    if (body instanceof Response) return body;
    return jsonResponse(body);
  });
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => '',
    setItem: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadFleetSummary', () => {
  it('aggregates per-agent state, pending counts and the latest verdict', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((path) => {
        if (path === '/agents') return { agents: AGENTS };
        if (path.endsWith('/state')) {
          const paused = path.includes('agent-2');
          return {
            agent: {
              status: paused ? 'paused' : 'running',
              activeVersion: 1,
              updatedAt: 0,
              activeModel: 'qwen3.6-plus',
            },
            autopilot: { enabled: false, mode: 'shadow', scanIntervalMs: 60000 },
            guardrails: {},
            toolNames: [],
            toolPolicies: [],
          };
        }
        if (path.endsWith('/approvals')) {
          return { approvals: path.includes('agent-1') ? [{ id: 'a1' }] : [] };
        }
        if (path.endsWith('/tool-calls/pending')) {
          return { toolCalls: path.includes('agent-1') ? [{ id: 't1' }, { id: 't2' }] : [] };
        }
        if (path.endsWith('/drift/history')) {
          return { history: [{ id: 'd-latest', at: 99, severity: 'high' }, { id: 'd-older', at: 1 }] };
        }
        throw new Error(`unexpected path: ${path}`);
      }),
    );

    const fleet = await loadFleetSummary();

    expect(fleet.agents.map((a) => a.definition.id)).toEqual(['agent-1', 'agent-2']);
    expect(fleet.agents[0].pendingApprovals).toBe(1);
    expect(fleet.agents[0].pendingToolCalls).toBe(2);
    expect(fleet.agents[1].state.status).toBe('paused');
    // Newest verdict only — history[0], not the whole list.
    expect(fleet.agents[0].lastVerdict?.id).toBe('d-latest');
    // Fleet-wide badge total spans both approval kinds across every agent.
    expect(fleet.pendingCount).toBe(3);
  });

  it('degrades a single failing agent instead of blanking the fleet', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((path) => {
        if (path === '/agents') return { agents: AGENTS };
        // agent-2 is mid-deregistration and 404s on every sub-resource.
        if (path.includes('agent-2')) return new Response('gone', { status: 404 });
        if (path.endsWith('/state')) {
          return {
            agent: { status: 'running', activeVersion: 3, updatedAt: 0 },
            autopilot: { enabled: false, mode: 'shadow', scanIntervalMs: 60000 },
            guardrails: {},
            toolNames: [],
            toolPolicies: [],
          };
        }
        if (path.endsWith('/approvals')) return { approvals: [] };
        if (path.endsWith('/tool-calls/pending')) return { toolCalls: [] };
        if (path.endsWith('/drift/history')) return { history: [] };
        throw new Error(`unexpected path: ${path}`);
      }),
    );

    const fleet = await loadFleetSummary();

    // Both agents still listed; the healthy one keeps its real data.
    expect(fleet.agents).toHaveLength(2);
    expect(fleet.agents[0].state.activeVersion).toBe(3);
    // The broken one falls back rather than rejecting the whole load.
    expect(fleet.agents[1].state.status).toBe('running');
    expect(fleet.agents[1].pendingApprovals).toBe(0);
    expect(fleet.agents[1].lastVerdict).toBeUndefined();
  });

  it('propagates a failure of the agent LIST itself — there is no fleet to show', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => new Response('unauthorized', { status: 401 })),
    );
    await expect(loadFleetSummary()).rejects.toThrow();
  });
});
