/**
 * The endpoints an SDK client talks to — as distinct from the console's.
 *
 * These exist because `DriftWatchAgent` (see @driftwatch/sdk) no longer shares a
 * database with the control plane. Everything an embedded agent needs now goes
 * over HTTP with a scoped API key:
 *
 *   POST /agents/:id/sync              push the code-declared baseline, get the
 *                                      EFFECTIVE config back in one round trip
 *   POST /agents/:id/tool-calls        open a gated tool call for a human
 *   GET  /agents/:id/tool-calls/:id    poll that decision
 *
 * ## Why sync is one call and not two
 *
 * The obvious shape is POST /agents to register, then GET /state to read back.
 * That is two round trips on every process start, and it races: another
 * deployment syncing concurrently could land between them. Returning the
 * effective config from the write means a client always sees the configuration
 * that its own baseline participated in producing.
 *
 * It is also, deliberately, the same endpoint a client re-polls for live policy
 * updates. The roadmap's "poll, not push" design and registration turn out to be
 * the same request — an agent that re-syncs every 60s both re-asserts its
 * baseline and picks up console overrides, with no second mechanism to build.
 */
import type { FastifyInstance } from 'fastify';
import type {
  AgentConfig,
  AgentDefinition,
  DriftWatchConfig,
  StateStore,
  ToolCallApproval,
  ToolCallPolicyRule,
} from '@driftwatch/sdk';
import {
  AGENT_ID_PATTERN,
  applyAgentOverride,
  overriddenFields,
  resolveAgentConfig,
  resolveToolCallPolicies,
} from '@driftwatch/sdk';
import type { ServerConfig } from '../config/server-config.js';
import type { AuthorizeFn } from './auth.js';
import type { AuditRecorder } from './audit.js';

export interface RegisterSdkRoutesOptions {
  store: StateStore;
  serverConfig: ServerConfig;
  driftWatchConfig: DriftWatchConfig;
  authorize: AuthorizeFn;
  recordAudit: AuditRecorder;
}

/** What a synced agent is told about itself. */
interface SyncResponse {
  agentId: string;
  /** Fully resolved guardrails: deployment defaults <- baseline <- override. */
  guardrails: AgentConfig;
  /** Effective tool-call policy rules. */
  toolPolicies: ToolCallPolicyRule[];
  /** The agent's tool allow-list, or null when it may call everything it declares. */
  toolNames: string[] | null;
  driftDetectionEnabled: boolean;
  /** Fields an operator has overridden, so a client can log that it is not running its own config. */
  overriddenFields: string[];
  /** Runtime posture — a paused agent should know it is paused. */
  status: string;
  /** Seconds the client should wait before re-syncing. */
  pollIntervalSeconds: number;
}

interface SyncBody {
  name?: string;
  owner?: string;
  serviceName?: string;
  guardrails?: Partial<AgentConfig>;
  toolPolicies?: ToolCallPolicyRule[];
  /** Names of the tools this client declares. Also the allow-list. */
  toolNames?: string[];
  driftDetectionEnabled?: boolean;
  sdkVersion?: string;
}

/** How often a client should re-sync to pick up console edits. */
const DEFAULT_POLL_INTERVAL_SECONDS = 60;

export async function registerSdkRoutes(
  fastifyServer: FastifyInstance,
  options: RegisterSdkRoutesOptions,
): Promise<void> {
  const { store, driftWatchConfig, authorize, recordAudit } = options;

  fastifyServer.post<{ Params: { agentId: string }; Body: SyncBody }>(
    '/agents/:agentId/sync',
    async (request, reply) => {
      const { agentId } = request.params;
      const body = request.body ?? {};

      if (!AGENT_ID_PATTERN.test(agentId)) {
        return reply.code(400).send({ error: 'agent id must match ^[a-zA-Z0-9_-]+$' });
      }
      // Sync writes guardrails and tool policies, so it needs policy:write as
      // well as agents:write — the same bar as declaring them through the
      // console. A deploy key that may only register agents cannot use this to
      // quietly widen its own limits.
      const principal = await authorize(request, reply, {
        scope: ['agents:write', 'policy:write'],
        agentId,
      });
      if (!principal) return;

      const existing = await store.getAgentDefinition(agentId);
      const baseline: AgentDefinition = {
        id: agentId,
        name: body.name ?? existing?.name ?? agentId,
        ...(body.owner !== undefined ? { owner: body.owner } : {}),
        ...(body.serviceName !== undefined ? { serviceName: body.serviceName } : {}),
        // Absent fields CLEAR rather than persist: this is a full declaration of
        // what the code says, so a policy the code stopped declaring must stop
        // being enforced. Anything an operator wants kept lives in the override.
        ...(body.guardrails !== undefined ? { guardrails: body.guardrails } : {}),
        ...(body.toolNames !== undefined ? { toolNames: body.toolNames } : {}),
        ...(body.toolPolicies !== undefined ? { toolPolicies: body.toolPolicies } : {}),
        ...(body.driftDetectionEnabled !== undefined
          ? { driftDetectionEnabled: body.driftDetectionEnabled }
          : {}),
        // Preserved by every store implementation; passed for a first-time create.
        createdAt: existing?.createdAt ?? Date.now(),
        ...(existing?.guardrailsSource !== undefined
          ? { guardrailsSource: existing.guardrailsSource }
          : {}),
        ...(existing?.toolPoliciesSource !== undefined
          ? { toolPoliciesSource: existing.toolPoliciesSource }
          : {}),
      };
      await store.upsertAgent(baseline);

      // Only audit a genuine registration or an actual change. A client
      // re-syncing every 60s would otherwise bury the audit log under
      // thousands of identical no-op entries and make it useless for the
      // question it exists to answer.
      if (!existing) {
        await recordAudit(
          principal,
          {
            action: 'agent.create',
            target: agentId,
            agentId,
            summary: `agent "${baseline.name}" registered itself via the SDK`,
          },
          request.log,
        );
      } else if (hasDeclarationChanged(existing, baseline)) {
        await recordAudit(
          principal,
          {
            action: 'policy.update',
            target: agentId,
            agentId,
            summary: 'agent re-synced a changed declaration from code',
          },
          request.log,
        );
      }

      return buildSyncResponse(store, driftWatchConfig, baseline);
    },
  );

  /**
   * Opens a gated tool call for a human decision. The calling agent is BLOCKED
   * on the response to this, so it must stay cheap.
   *
   * `approvals:write` rather than `policy:write`: creating one is participating
   * in the approval flow, not changing what gets gated.
   */
  fastifyServer.post<{ Params: { agentId: string }; Body: Partial<ToolCallApproval> }>(
    '/agents/:agentId/tool-calls',
    async (request, reply) => {
      const { agentId } = request.params;
      const principal = await authorize(request, reply, { scope: 'approvals:write', agentId });
      if (!principal) return;

      const agent = await store.getAgentDefinition(agentId);
      if (!agent) return reply.code(404).send({ error: `unknown agent: ${agentId}` });

      const body = request.body ?? {};
      if (!body.id || !body.tool) {
        return reply.code(400).send({ error: 'id and tool are required' });
      }
      const approval: ToolCallApproval = {
        id: body.id,
        agentId,
        tool: body.tool,
        ...(body.fieldPath !== undefined ? { fieldPath: body.fieldPath } : {}),
        ...(body.matchedReason !== undefined ? { matchedReason: body.matchedReason } : {}),
        ...(body.inputSummary !== undefined ? { inputSummary: body.inputSummary } : {}),
        status: 'pending',
        createdAt: body.createdAt ?? Date.now(),
        expiresAt: body.expiresAt ?? Date.now() + 120_000,
      };
      await store.createToolCallApproval(approval);
      return reply.code(201).send({ toolCall: approval });
    },
  );

  /** Polled by a blocked agent until the decision lands or it times out locally. */
  fastifyServer.get<{ Params: { agentId: string; id: string } }>(
    '/agents/:agentId/tool-calls/:id',
    async (request, reply) => {
      const { agentId, id } = request.params;
      if (!(await authorize(request, reply, { scope: 'read', agentId }))) return;
      const toolCall = await store.getToolCallApproval(id);
      if (!toolCall || toolCall.agentId !== agentId) {
        // The agentId check matters: ids are globally unique, so without it a
        // key scoped to one agent could read another's captured tool input.
        return reply.code(404).send({ error: 'unknown tool call' });
      }
      return { toolCall };
    },
  );
}

/** Resolves and shapes what a synced client is told about itself. */
async function buildSyncResponse(
  store: StateStore,
  driftWatchConfig: DriftWatchConfig,
  baseline: AgentDefinition,
): Promise<SyncResponse> {
  const override = await store.getAgentOverride(baseline.id);
  const effective = applyAgentOverride(baseline, override);

  const sourceAgent = effective.guardrailsSource
    ? await store.getAgentDefinition(effective.guardrailsSource)
    : undefined;
  const sourceForTools =
    effective.toolPoliciesSource === effective.guardrailsSource
      ? sourceAgent
      : effective.toolPoliciesSource
        ? await store.getAgentDefinition(effective.toolPoliciesSource)
        : undefined;

  const state = await store.getAgentState(baseline.id);

  return {
    agentId: baseline.id,
    guardrails: resolveAgentConfig(effective, driftWatchConfig, sourceAgent),
    toolPolicies: resolveToolCallPolicies(effective, sourceForTools),
    toolNames: effective.toolNames ?? null,
    driftDetectionEnabled: effective.driftDetectionEnabled ?? true,
    overriddenFields: overriddenFields(override),
    status: state.status,
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

/**
 * Whether a re-sync actually changed the declaration.
 *
 * Compares only the governing fields, by serialised value. A deep-equality
 * helper would be more elegant but these are small JSON-shaped records that
 * came off the wire moments ago, so key order is stable and the comparison is
 * honest.
 */
function hasDeclarationChanged(previous: AgentDefinition, next: AgentDefinition): boolean {
  const shape = (definition: AgentDefinition) =>
    JSON.stringify([
      definition.guardrails ?? null,
      definition.toolNames ?? null,
      definition.toolPolicies ?? null,
      definition.driftDetectionEnabled ?? null,
      definition.name,
    ]);
  return shape(previous) !== shape(next);
}
