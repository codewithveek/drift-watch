/**
 * HTTP client for the DriftWatch control plane.
 *
 * This is the ONLY way an SDK-embedded agent talks to a DriftWatch deployment.
 * It replaces the previous arrangement where the SDK imported a `StateStore` and
 * reached into the control plane's database directly — which meant an agent in a
 * Lambda carried a Redis client, and the SDK and server could never be versioned
 * independently because they shared a storage interface.
 *
 * Everything here is `fetch` and JSON. No dependency is added by this file.
 *
 * ## Failure policy, split by what failed
 *
 * Following the roadmap's fail-open/fail-closed split rather than one global
 * switch:
 *
 *   - **Sync failure fails OPEN.** If the control plane is unreachable at boot,
 *     the agent runs with the configuration declared in its own code and logs a
 *     warning. DriftWatch must never become an availability risk for somebody
 *     else's production agent; an observability tool that takes down the thing
 *     it observes is worse than no tool.
 *   - **Approval failure fails CLOSED.** If a gated tool call cannot be opened
 *     or its decision cannot be read, the call is denied. The entire point of
 *     the gate is "do not act when unsure", so an unreachable control plane must
 *     not become an open door.
 *
 * That asymmetry is deliberate and is the reason these are separate methods with
 * separate error handling rather than one generic request helper that treats
 * every failure alike.
 */
import type { AgentConfig } from '../config/schema.js';
import type { ToolCallPolicyRule } from '../autopilot/tool-call-policy.js';
import type { AgentDefinition, ToolCallApproval } from '../autopilot/types.js';
import type { ToolCallApprovalTransport } from '../autopilot/tool-call-gate.js';

/** The configuration a control plane reports as actually in force. */
export interface EffectiveAgentConfig {
  agentId: string;
  guardrails: AgentConfig;
  toolPolicies: ToolCallPolicyRule[];
  toolNames: string[] | null;
  driftDetectionEnabled: boolean;
  /** Non-empty when an operator has overridden what this code declared. */
  overriddenFields: string[];
  status: string;
  pollIntervalSeconds: number;
}

/** The declaration a client pushes. Absent fields are cleared, not preserved. */
export interface AgentDeclaration {
  name?: string;
  owner?: string;
  serviceName?: string;
  guardrails?: Partial<AgentConfig>;
  toolPolicies?: ToolCallPolicyRule[];
  toolNames?: string[];
  driftDetectionEnabled?: boolean;
  sdkVersion?: string;
}

export interface ControlPlaneClientOptions {
  /** Base URL of the deployment, e.g. https://driftwatch.acme.internal. */
  url: string;
  /** A scoped API key minted in the console. */
  apiKey: string;
  /** Per-request timeout. Defaults to 10s. */
  timeoutMs?: number;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

/** Version pinned into the API path — see the server's /api/v1 namespace. */
const API_VERSION = 'v1';

export class ControlPlaneClient implements ToolCallApprovalTransport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: ControlPlaneClientOptions) {
    // Trailing slashes are the classic source of `//api/v1` paths that 404 on
    // some proxies and work on others.
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Pushes the code-declared baseline and returns the configuration actually in
   * force, including any console overrides.
   *
   * One round trip, deliberately: registering and reading back separately would
   * double the boot cost and leave a window in which a concurrent edit lands
   * between the two.
   */
  async sync(agentId: string, declaration: AgentDeclaration): Promise<EffectiveAgentConfig> {
    return this.request<EffectiveAgentConfig>(
      'POST',
      `/agents/${encodeURIComponent(agentId)}/sync`,
      declaration,
    );
  }

  // --- ToolCallApprovalTransport -------------------------------------------

  async createToolCallApproval(approval: ToolCallApproval): Promise<void> {
    await this.request<{ toolCall: ToolCallApproval }>(
      'POST',
      `/agents/${encodeURIComponent(approval.agentId)}/tool-calls`,
      approval,
    );
  }

  /**
   * Polled by a blocked tool call. A 404 resolves to `undefined` rather than
   * throwing: the gate reads that as "no decision yet" and keeps waiting, which
   * is the correct behaviour for a record that may not have replicated yet.
   * Every other failure propagates, and the gate fails closed on it.
   */
  async getToolCallApproval(id: string): Promise<ToolCallApproval | undefined> {
    if (!this.pendingAgentId) return undefined;
    try {
      const { toolCall } = await this.request<{ toolCall: ToolCallApproval }>(
        'GET',
        `/agents/${encodeURIComponent(this.pendingAgentId)}/tool-calls/${encodeURIComponent(id)}`,
      );
      return toolCall;
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 404) return undefined;
      throw error;
    }
  }

  async resolveToolCallApproval(
    id: string,
    status: 'approved' | 'rejected' | 'expired',
    resolvedBy: string,
    channel: string,
  ): Promise<ToolCallApproval | undefined> {
    if (!this.pendingAgentId) return undefined;
    const { toolCall } = await this.request<{ toolCall: ToolCallApproval }>(
      'POST',
      `/agents/${encodeURIComponent(this.pendingAgentId)}/tool-calls/${encodeURIComponent(id)}/resolve`,
      { decision: status === 'expired' ? 'rejected' : status, actor: resolvedBy, channel },
    );
    return toolCall;
  }

  async getAgentDefinition(agentId: string): Promise<AgentDefinition | undefined> {
    try {
      const { agent } = await this.request<{ agent: AgentDefinition }>(
        'GET',
        `/agents/${encodeURIComponent(agentId)}`,
      );
      return agent;
    } catch {
      // Only used to put a friendly name on a notification. Failing that is not
      // a reason to fail the approval.
      return undefined;
    }
  }

  /**
   * The agent whose tool calls this client is currently gating.
   *
   * `ToolCallApprovalTransport`'s get/resolve signatures carry only the approval
   * id — they were shaped for a StateStore, where ids are globally unique and an
   * agent scope is unnecessary. The HTTP routes are per-agent (so an
   * agent-scoped key cannot read another agent's captured tool input), so the
   * client has to supply it. `DriftWatchAgent` binds this once at construction.
   */
  private pendingAgentId: string | undefined;

  /** Binds this client to one agent for the approval-transport methods. */
  forAgent(agentId: string): this {
    this.pendingAgentId = agentId;
    return this;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // AbortSignal.timeout rather than a manual setTimeout/clearTimeout pair:
    // the latter leaks a live timer per request on a long-lived process.
    const response = await fetch(`${this.baseUrl}/api/${API_VERSION}${path}`, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      throw new ControlPlaneError(response.status, await readError(response));
    }
    return (await response.json()) as T;
  }
}

/** Server errors are `{ error }`; anything in front of it may not be. */
async function readError(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? response.statusText;
  } catch {
    return response.statusText || `request failed (${response.status})`;
  }
}
