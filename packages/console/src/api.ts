/**
 * Thin API client for the control-plane. Same-origin fetch (the console is
 * served from the server at /console/, and in dev Vite proxies these paths),
 * with a bearer token kept in localStorage so approvals survive a refresh.
 *
 * Entity types are imported from @driftwatch/sdk rather than redefined here.
 * They used to be hand-copied, and they silently drifted: the local
 * AgentDefinition carried 5 fields while the server had grown to 11, so
 * guardrails, toolNames and toolPolicies were invisible to the console.
 * `verbatimModuleSyntax` (see tsconfig) makes these type-only imports
 * enforceable — the SDK's runtime entry pulls in OpenTelemetry and must never
 * reach the browser bundle.
 *
 * The response ENVELOPES below are the one thing the SDK can't give us: they
 * exist only inline in packages/server/src/routes/console.ts. Every field is
 * still expressed in SDK types so entity drift is impossible, and
 * static-console/console.test.ts pins the server's actual key set so envelope
 * drift fails a test rather than reaching users.
 */
import type {
  ActionLogEntry,
  AgentConfig,
  AgentDefinition,
  AgentRuntimeState,
  AgentStatus,
  Approval,
  DriftHistoryEntry,
  DriftSeverity,
  ToolCallApproval,
  ToolCallPolicyRule,
} from '@driftwatch/sdk';

export type {
  ActionLogEntry,
  AgentConfig,
  AgentDefinition,
  AgentRuntimeState,
  AgentStatus,
  Approval,
  DriftHistoryEntry,
  DriftSeverity,
  ToolCallApproval,
  ToolCallPolicyRule,
};

/** GET /agents/:agentId/state */
export interface StateResponse {
  agent: AgentRuntimeState;
  autopilot: { enabled: boolean; mode: 'enforce' | 'shadow'; scanIntervalMs: number };
  /** Fully resolved: global defaults <- guardrailsSource <- this agent's own overrides. */
  guardrails: AgentConfig;
  /** The agent's allow-list, or every registered tool when it has none. */
  toolNames: string[];
  /** Resolved union of this agent's policies and any toolPoliciesSource's. */
  toolPolicies: ToolCallPolicyRule[];
}

export interface DriftVerdict {
  drift: boolean;
  severity: DriftSeverity;
  reasons: string[];
  recommended_action: string;
}

const TOKEN_KEY = 'driftwatch.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** Thrown for any non-2xx response, carrying the status so callers can branch on 401/404. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    // The server's errors are `{ error: string }`; fall back to raw text.
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // not JSON — keep the raw body
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const client = {
  // --- fleet ---------------------------------------------------------------
  getAgents: () => api<{ agents: AgentDefinition[] }>('/agents'),
  getAgent: (agentId: string) => api<{ agent: AgentDefinition }>(`/agents/${agentId}`),
  registerAgent: (body: Partial<AgentDefinition> & { name: string }) =>
    post<{ agent: AgentDefinition }>('/agents', body),
  updateAgent: (agentId: string, patch: Partial<AgentDefinition>) =>
    api<{ agent: AgentDefinition }>(`/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  getTools: () => api<{ tools: string[] }>('/tools'),

  // --- per-agent state / history -------------------------------------------
  getState: (agentId: string) => api<StateResponse>(`/agents/${agentId}/state`),
  getDriftHistory: (agentId: string) =>
    api<{ history: DriftHistoryEntry[] }>(`/agents/${agentId}/drift/history`),
  getActionLog: (agentId: string) =>
    api<{ log: ActionLogEntry[] }>(`/agents/${agentId}/actions/log`),

  // --- control approvals (Loop 2) ------------------------------------------
  getApprovals: (agentId: string) => api<{ approvals: Approval[] }>(`/agents/${agentId}/approvals`),
  resolveApproval: (agentId: string, id: string, decision: 'approved' | 'rejected') =>
    post<{ approval: Approval }>(`/agents/${agentId}/approvals/${id}/resolve`, {
      decision,
      actor: 'console',
    }),

  // --- tool-call approvals (Loop 3) ----------------------------------------
  // A pending one is holding a live HTTP request open, so these are the most
  // time-sensitive items in the console.
  getPendingToolCalls: (agentId: string) =>
    api<{ toolCalls: ToolCallApproval[] }>(`/agents/${agentId}/tool-calls/pending`),
  resolveToolCall: (agentId: string, id: string, decision: 'approved' | 'rejected') =>
    post<{ toolCall: ToolCallApproval }>(`/agents/${agentId}/tool-calls/${id}/resolve`, {
      decision,
      actor: 'console',
    }),

  // --- control actions ------------------------------------------------------
  control: (agentId: string, action: 'pause' | 'resume' | 'rollback') =>
    post<{ applied: boolean; state: AgentRuntimeState }>(`/agents/${agentId}/control/${action}`),
  scan: (agentId: string) =>
    post<{ verdict?: DriftVerdict; intents: unknown[] }>(`/agents/${agentId}/drift/scan`),
};
