/**
 * Thin API client for the control-plane. Same-origin fetch (the console is
 * served from the server at /console/, and in dev Vite proxies these paths),
 * with a bearer token kept in localStorage so approvals survive a refresh.
 */
export type AgentStatus = 'running' | 'paused' | 'throttled';
export type DriftSeverity = 'none' | 'low' | 'medium' | 'high';

export interface AgentRuntimeState {
  status: AgentStatus;
  activeModel?: string;
  activeVersion: number;
  updatedAt: number;
  reason?: string;
}

export interface StateResponse {
  agent: AgentRuntimeState;
  autopilot: { enabled: boolean; mode: 'enforce' | 'shadow'; scanIntervalMs: number };
  guardrails: { maxTokensPerTask: number; maxCostUsd: number; onExceed: string };
}

export interface Approval {
  id: string;
  action: string;
  severity: DriftSeverity;
  reasons: string[];
  recommendedAction: string;
  status: string;
  createdAt: number;
  expiresAt: number;
}

export interface DriftHistoryEntry {
  id: string;
  at: number;
  drift: boolean;
  severity: DriftSeverity;
  reasons: string[];
  recommendedAction: string;
  baselineTokenSpend: number;
  currentTokenSpend: number;
}

export interface ActionLogEntry {
  id: string;
  at: number;
  action: string;
  category: 'notify' | 'control';
  outcome: string;
  reason: string;
  actor?: string;
  channel?: string;
}

const TOKEN_KEY = 'driftwatch.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
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
    throw new Error(`${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

export const client = {
  getState: () => api<StateResponse>('/state'),
  getApprovals: () => api<{ approvals: Approval[] }>('/approvals'),
  getDriftHistory: () => api<{ history: DriftHistoryEntry[] }>('/drift/history'),
  getActionLog: () => api<{ log: ActionLogEntry[] }>('/actions/log'),
  resolveApproval: (id: string, decision: 'approved' | 'rejected') =>
    api<{ approval: Approval }>(`/approvals/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ decision, actor: 'console' }),
    }),
  control: (action: 'pause' | 'resume' | 'rollback') =>
    api<{ applied: boolean; state: AgentRuntimeState }>(`/control/${action}`, {
      method: 'POST',
    }),
  scan: () => api<{ verdict: unknown; intents: unknown[] }>('/drift/scan', { method: 'POST' }),
};
