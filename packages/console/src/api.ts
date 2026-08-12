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
  ApiKeyScope,
  Approval,
  AuditAction,
  AuditEvent,
  DriftHistoryEntry,
  DriftSeverity,
  PublicApiKey,
  ToolCallApproval,
  ToolCallPolicyRule,
} from '@driftwatch/sdk';

export type {
  ActionLogEntry,
  AgentConfig,
  AgentDefinition,
  AgentRuntimeState,
  AgentStatus,
  ApiKeyScope,
  Approval,
  AuditAction,
  AuditEvent,
  DriftHistoryEntry,
  DriftSeverity,
  PublicApiKey,
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

/**
 * GET /tools. Mirrors `ToolMetadata` in packages/server/src/tools.ts — the
 * boolean hints deliberately echo MCP's tool-annotation vocabulary, and
 * `fields` is what makes field-scoped policy authoring possible at all.
 * These are descriptive only: nothing is gated because a tool is marked
 * destructive, gating comes solely from explicit policy rules.
 */
export interface ToolMetadata {
  name: string;
  description: string;
  fields: string[];
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  sensitiveFields?: string[];
}

export interface DriftVerdict {
  drift: boolean;
  severity: DriftSeverity;
  reasons: string[];
  recommended_action: string;
}

/**
 * GET /api-keys. The scope catalogue is served rather than hardcoded here —
 * the SDK's runtime entry pulls in OpenTelemetry, so this package can only
 * import SDK *types*, never the `API_KEY_SCOPES` value itself.
 */
export interface ApiKeysResponse {
  keys: PublicApiKey[];
  scopes: { name: ApiKeyScope; description: string }[];
}

/**
 * POST /api-keys. `token` is the plaintext credential and is returned exactly
 * once, by this response, and never again — the server stores only its
 * sha256. Everything that displays it must treat closing the dialog as
 * destroying it.
 */
export interface CreatedApiKey {
  key: PublicApiKey;
  token: string;
}

export interface CreateApiKeyRequest {
  name: string;
  scopes: ApiKeyScope[];
  /** Omit or leave empty for a fleet-wide key. */
  agentIds?: string[];
  /** Epoch ms. Omit for a key that never expires. */
  expiresAt?: number;
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

function del<T>(path: string): Promise<T> {
  return api<T>(path, { method: 'DELETE' });
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
  getTools: () => api<{ tools: ToolMetadata[] }>('/tools'),

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

  // --- api keys -------------------------------------------------------------
  // All three need the `keys:admin` scope AND a fleet-wide principal, so an
  // agent-scoped key gets a 403 here rather than a filtered list.
  getApiKeys: () => api<ApiKeysResponse>('/api-keys'),
  createApiKey: (body: CreateApiKeyRequest) => post<CreatedApiKey>('/api-keys', body),
  revokeApiKey: (id: string) => del<{ key: PublicApiKey }>(`/api-keys/${id}`),

  // --- audit trail ----------------------------------------------------------
  /** Fleet-wide by default; pass an agentId to scope it (required for scoped keys). */
  getAuditEvents: (agentId?: string) =>
    api<{ events: AuditEvent[] }>(agentId ? `/audit?agentId=${agentId}` : '/audit'),

  // --- control actions ------------------------------------------------------
  control: (agentId: string, action: 'pause' | 'resume' | 'rollback') =>
    post<{ applied: boolean; state: AgentRuntimeState }>(`/agents/${agentId}/control/${action}`),
  scan: (agentId: string) =>
    post<{ verdict?: DriftVerdict; intents: unknown[] }>(`/agents/${agentId}/drift/scan`),
};
