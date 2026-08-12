/**
 * Control-plane API — the bearer-gated surface the React console (and any
 * operator script) talks to. Every route goes through the same `authorize`
 * gate as /run and /drift (routes/auth.ts), declaring the scope it needs and
 * the agent it touches, so there is one auth story for the whole control
 * plane and an agent-scoped key physically cannot reach another agent.
 *
 * Everything here reads/writes the SHARED StateStore, so the console, Slack,
 * and Telegram always see the same truth. Every route except /agents itself
 * (list + register), /tools and /audit is scoped to one agent via an :agentId
 * path param, and 404s early if that agent isn't registered — see requireAgent
 * below. Guardrails/tools are resolved fresh from the AgentDefinition on
 * every request (see resolveAgentConfig/buildAgentTools in routes/agent.ts),
 * so a PATCH here takes effect on the very next /run call — no restart, no
 * polling, no cache to invalidate.
 *
 * Mutations record an AuditEvent naming the principal and the fields touched
 * (never their values) — see routes/audit.ts.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  AgentConfig,
  AgentDefinition,
  DriftWatchConfig,
  StateStore,
  ApprovalService,
  AutopilotScheduler,
  ToolCallPolicyRule,
} from '@driftwatch/sdk';
import {
  AGENT_ID_PATTERN,
  executeControlAction,
  generateAgentSlug,
  resolveAgentConfig,
  resolveToolCallPolicies,
} from '@driftwatch/sdk';
import type { ServerConfig } from '../config/server-config.js';
import { visibleToPrincipal, type AuthorizeFn } from './auth.js';
import { describeChangedFields, touchesPolicy, type AuditRecorder } from './audit.js';
import { allToolMetadata, allToolNames } from '../tools.js';

const HISTORY_LIMIT = 100;
const AUDIT_LIMIT = 200;

export interface RegisterConsoleRoutesOptions {
  store: StateStore;
  serverConfig: ServerConfig;
  driftWatchConfig: DriftWatchConfig;
  approvalService: ApprovalService;
  authorize: AuthorizeFn;
  recordAudit: AuditRecorder;
  /**
   * Always present. AUTOPILOT_ENABLED governs the periodic scan loop, not
   * whether on-demand scans exist — see autopilot/index.ts.
   */
  scheduler: AutopilotScheduler;
}

/** Looks up an agent, 404ing (and returning undefined) if it isn't registered. */
async function requireAgent(
  store: StateStore,
  agentId: string,
  reply: FastifyReply,
): Promise<AgentDefinition | undefined> {
  const agent = await store.getAgentDefinition(agentId);
  if (!agent) {
    reply.code(404).send({ error: `unknown agent: ${agentId}` });
    return undefined;
  }
  return agent;
}

/** Rejects (and 400s) any toolNames not present in the server's tool registry. */
function validateToolNames(toolNames: string[] | undefined, reply: FastifyReply): boolean {
  if (!toolNames) return true;
  const unknown = toolNames.filter((name) => !allToolNames.includes(name));
  if (unknown.length > 0) {
    reply.code(400).send({ error: `unknown tool names: ${unknown.join(', ')}` });
    return false;
  }
  return true;
}

/** Rejects (and 400s) any toolPolicies rule whose `tool` isn't a registered tool name or '*'. */
function validateToolPolicies(
  toolPolicies: ToolCallPolicyRule[] | undefined,
  reply: FastifyReply,
): boolean {
  if (!toolPolicies) return true;
  const unknown = toolPolicies
    .map((rule) => rule.tool)
    .filter((toolName) => toolName !== '*' && !allToolNames.includes(toolName));
  if (unknown.length > 0) {
    reply.code(400).send({ error: `toolPolicies reference unknown tool names: ${unknown.join(', ')}` });
    return false;
  }
  return true;
}

/**
 * A reference field (guardrailsSource / toolPoliciesSource) must point at a
 * different, existing agent — self-refs and dangling refs both 400. Shared
 * by both fields since the self-ref/dangling-ref check is identical; only
 * the error message names which field failed.
 */
async function validateAgentReference(
  store: StateStore,
  refId: string,
  selfId: string,
  fieldName: string,
  reply: FastifyReply,
): Promise<boolean> {
  const source = refId !== selfId ? await store.getAgentDefinition(refId) : undefined;
  if (!source) {
    reply.code(400).send({ error: `${fieldName} must reference a different, existing agent` });
    return false;
  }
  return true;
}

interface AgentWriteBody {
  id?: string;
  name?: string;
  owner?: string;
  serviceName?: string;
  guardrails?: Partial<AgentConfig>;
  guardrailsSource?: string;
  toolNames?: string[];
  driftDetectionEnabled?: boolean;
  toolPolicies?: ToolCallPolicyRule[];
  toolPoliciesSource?: string;
}

export async function registerConsoleRoutes(
  fastifyServer: FastifyInstance,
  options: RegisterConsoleRoutesOptions,
): Promise<void> {
  const { store, serverConfig, driftWatchConfig, approvalService, scheduler } = options;
  const { authorize, recordAudit } = options;

  // --- agent registry -------------------------------------------------------

  fastifyServer.get('/agents', async (request, reply) => {
    const principal = await authorize(request, reply, { scope: 'read' });
    if (!principal) return;
    // Narrowed rather than 403'd: an agent-scoped key listing the fleet is a
    // legitimate request for "the agents I can see", not an access violation.
    return { agents: visibleToPrincipal(principal, await store.listAgents()) };
  });

  fastifyServer.post<{ Body: AgentWriteBody }>('/agents', async (request, reply) => {
    const body = request.body ?? {};
    // Without an explicit id the server generates a slug, which an agent-scoped
    // key could never have been granted in advance — so creating one is a
    // fleet-wide act. With an explicit id it's a normal per-agent resource check
    // (and doubles as the upsert path for re-registering an agent you hold).
    const principal = await authorize(request, reply, {
      scope: touchesPolicy(body as Record<string, unknown>)
        ? ['agents:write', 'policy:write']
        : 'agents:write',
      ...(body.id ? { agentId: body.id } : { fleetWide: true }),
    });
    if (!principal) return;

    const {
      name,
      owner,
      serviceName,
      guardrails,
      guardrailsSource,
      toolNames,
      driftDetectionEnabled,
      toolPolicies,
      toolPoliciesSource,
    } = body;
    if (!name) {
      return reply.code(400).send({ error: 'name (string) required' });
    }
    const id = body.id || generateAgentSlug(name);
    if (!AGENT_ID_PATTERN.test(id)) {
      return reply.code(400).send({ error: 'id must match ^[a-zA-Z0-9_-]+$' });
    }
    if (!validateToolNames(toolNames, reply)) return;
    if (!validateToolPolicies(toolPolicies, reply)) return;
    if (guardrailsSource && !(await validateAgentReference(store, guardrailsSource, id, 'guardrailsSource', reply))) return;
    if (
      toolPoliciesSource &&
      !(await validateAgentReference(store, toolPoliciesSource, id, 'toolPoliciesSource', reply))
    ) {
      return;
    }

    // Upsert semantics: re-registering an existing id updates it (preserving
    // createdAt) rather than resetting its history — 200 vs 201 reflects that.
    const existing = await store.getAgentDefinition(id);
    const definition: AgentDefinition = {
      id,
      name,
      owner,
      serviceName,
      guardrails,
      guardrailsSource,
      toolNames,
      driftDetectionEnabled,
      toolPolicies,
      toolPoliciesSource,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    await store.upsertAgent(definition);
    await recordAudit(
      principal,
      {
        action: existing ? 'agent.update' : 'agent.create',
        target: id,
        agentId: id,
        summary: `${existing ? 're-registered' : 'registered'} agent "${name}" with ${describeChangedFields(body as Record<string, unknown>)}`,
      },
      request.log,
    );
    return reply.code(existing ? 200 : 201).send({ agent: definition });
  });

  fastifyServer.get<{ Params: { agentId: string } }>('/agents/:agentId', async (request, reply) => {
    const principal = await authorize(request, reply, {
      scope: 'read',
      agentId: request.params.agentId,
    });
    if (!principal) return;
    const agent = await requireAgent(store, request.params.agentId, reply);
    if (!agent) return;
    // Raw, unresolved definition — for populating an edit form. /state below
    // returns the *resolved* (merged) view for display, which you don't want
    // to PATCH back (it would bake an inherited guardrailsSource in as a
    // hard override).
    return { agent };
  });

  fastifyServer.patch<{ Params: { agentId: string }; Body: AgentWriteBody }>(
    '/agents/:agentId',
    async (request, reply) => {
      const body = request.body ?? {};
      // Identity edits need agents:write; anything governing spend or tool
      // access additionally needs policy:write.
      const principal = await authorize(request, reply, {
        scope: touchesPolicy(body as Record<string, unknown>)
          ? ['agents:write', 'policy:write']
          : 'agents:write',
        agentId: request.params.agentId,
      });
      if (!principal) return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;

      if (!validateToolNames(body.toolNames, reply)) return;
      if (!validateToolPolicies(body.toolPolicies, reply)) return;
      if (
        body.guardrailsSource &&
        !(await validateAgentReference(store, body.guardrailsSource, agent.id, 'guardrailsSource', reply))
      ) {
        return;
      }
      if (
        body.toolPoliciesSource &&
        !(await validateAgentReference(
          store,
          body.toolPoliciesSource,
          agent.id,
          'toolPoliciesSource',
          reply,
        ))
      ) {
        return;
      }

      const updated: AgentDefinition = {
        ...agent,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.owner !== undefined ? { owner: body.owner } : {}),
        ...(body.serviceName !== undefined ? { serviceName: body.serviceName } : {}),
        // Nested partial merge: patching just one guardrail field doesn't
        // clobber previously-set ones.
        ...(body.guardrails !== undefined
          ? { guardrails: { ...agent.guardrails, ...body.guardrails } }
          : {}),
        ...(body.guardrailsSource !== undefined ? { guardrailsSource: body.guardrailsSource } : {}),
        ...(body.toolNames !== undefined ? { toolNames: body.toolNames } : {}),
        ...(body.driftDetectionEnabled !== undefined
          ? { driftDetectionEnabled: body.driftDetectionEnabled }
          : {}),
        // Full replace, not a merge — a rule LIST composes by "which rules
        // apply," unlike guardrails' flat-record per-field merge above.
        ...(body.toolPolicies !== undefined ? { toolPolicies: body.toolPolicies } : {}),
        ...(body.toolPoliciesSource !== undefined ? { toolPoliciesSource: body.toolPoliciesSource } : {}),
      };
      await store.upsertAgent(updated);
      const changedFields = describeChangedFields(body as Record<string, unknown>);
      await recordAudit(
        principal,
        {
          // Field NAMES only — a guardrail diff that printed values could put a
          // secret into a log any `read` principal can fetch.
          action: touchesPolicy(body as Record<string, unknown>) ? 'policy.update' : 'agent.update',
          target: agent.id,
          agentId: agent.id,
          summary: `updated ${changedFields}`,
        },
        request.log,
      );
      return { agent: updated };
    },
  );

  fastifyServer.get('/tools', async (request, reply) => {
    if (!(await authorize(request, reply, { scope: 'read' }))) return;
    // Full metadata, not just names: the console's policy editor needs each
    // tool's matchable fields before it can offer a rule against one.
    return { tools: allToolMetadata };
  });

  // --- per-agent state/history/approvals/log --------------------------------

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/state',
    async (request, reply) => {
      if (!(await authorize(request, reply, { scope: 'read', agentId: request.params.agentId })))
        return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      const sourceAgent = agent.guardrailsSource
        ? await store.getAgentDefinition(agent.guardrailsSource)
        : undefined;
      const sourceAgentForTools =
        agent.toolPoliciesSource === agent.guardrailsSource
          ? sourceAgent
          : agent.toolPoliciesSource
            ? await store.getAgentDefinition(agent.toolPoliciesSource)
            : undefined;
      return {
        agent: await store.getAgentState(agent.id),
        autopilot: {
          enabled: serverConfig.autopilotEnabled,
          mode: serverConfig.autopilotMode,
          scanIntervalMs: serverConfig.scanIntervalMs,
        },
        guardrails: resolveAgentConfig(agent, driftWatchConfig, sourceAgent),
        toolNames: agent.toolNames ?? allToolNames,
        toolPolicies: resolveToolCallPolicies(agent, sourceAgentForTools),
      };
    },
  );

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/drift/history',
    async (request, reply) => {
      if (!(await authorize(request, reply, { scope: 'read', agentId: request.params.agentId })))
        return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      return { history: await store.listDriftHistory(agent.id, HISTORY_LIMIT) };
    },
  );

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/approvals',
    async (request, reply) => {
      if (!(await authorize(request, reply, { scope: 'read', agentId: request.params.agentId })))
        return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      return { approvals: await store.listPendingApprovals(agent.id) };
    },
  );

  fastifyServer.post<{
    Params: { agentId: string; id: string };
    Body: { decision?: string; actor?: string };
  }>('/agents/:agentId/approvals/:id/resolve', async (request, reply) => {
    const principal = await authorize(request, reply, {
      scope: 'approvals:write',
      agentId: request.params.agentId,
    });
    if (!principal) return;
    const agent = await requireAgent(store, request.params.agentId, reply);
    if (!agent) return;

    const decision = request.body?.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      return reply.code(400).send({ error: "decision must be 'approved' or 'rejected'" });
    }

    // Pre-check the approval actually belongs to this agent BEFORE resolving
    // — resolveApproval itself is id-only (webhook compatibility, see
    // @driftwatch/sdk's StateStore docs), so without this check a mismatched
    // path agentId could resolve (and execute a control action against)
    // a different agent's approval.
    const existing = await store.getApproval(request.params.id);
    if (!existing || existing.agentId !== agent.id) {
      return reply.code(404).send({ error: 'approval not found for this agent' });
    }

    const actor = request.body?.actor || 'console';
    const resolved = await approvalService.resolve(request.params.id, decision, actor, 'console');
    if (!resolved) {
      return reply.code(409).send({ error: 'approval missing or already resolved' });
    }
    await recordAudit(
      principal,
      {
        action: 'approval.resolve',
        target: resolved.id,
        agentId: agent.id,
        summary: `${decision} ${resolved.action} approval (${resolved.severity} severity) as "${actor}"`,
      },
      request.log,
    );
    return { approval: resolved };
  });

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/tool-calls/pending',
    async (request, reply) => {
      if (!(await authorize(request, reply, { scope: 'read', agentId: request.params.agentId })))
        return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      return { toolCalls: await store.listPendingToolCallApprovals(agent.id) };
    },
  );

  fastifyServer.post<{
    Params: { agentId: string; id: string };
    Body: { decision?: string; actor?: string };
  }>('/agents/:agentId/tool-calls/:id/resolve', async (request, reply) => {
    const principal = await authorize(request, reply, {
      scope: 'approvals:write',
      agentId: request.params.agentId,
    });
    if (!principal) return;
    const agent = await requireAgent(store, request.params.agentId, reply);
    if (!agent) return;

    const decision = request.body?.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      return reply.code(400).send({ error: "decision must be 'approved' or 'rejected'" });
    }

    // Same cross-agent pre-check as the control-approval resolve route above.
    const existing = await store.getToolCallApproval(request.params.id);
    if (!existing || existing.agentId !== agent.id) {
      return reply.code(404).send({ error: 'tool-call approval not found for this agent' });
    }

    const actor = request.body?.actor || 'console';
    // No executeControlAction here, unlike the control-approval route above —
    // approving a tool-call approval has no AgentRuntimeState mutation to
    // perform, it only needs to flip status so gateToolCall's poll loop
    // (already waiting inside the in-flight tool call) observes it.
    const resolved = await store.resolveToolCallApproval(request.params.id, decision, actor, 'console');
    if (!resolved) {
      return reply.code(409).send({ error: 'tool-call approval missing or already resolved' });
    }
    await recordAudit(
      principal,
      {
        action: 'toolcall.resolve',
        target: resolved.id,
        agentId: agent.id,
        // The tool NAME, never inputSummary — that's the captured payload the
        // gate exists to protect.
        summary: `${decision} tool call "${resolved.tool}" as "${actor}"`,
      },
      request.log,
    );
    return { toolCall: resolved };
  });

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/actions/log',
    async (request, reply) => {
      if (!(await authorize(request, reply, { scope: 'read', agentId: request.params.agentId })))
        return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      return { log: await store.listActionLog(agent.id, HISTORY_LIMIT) };
    },
  );

  /**
   * The fleet-wide audit log — who changed what. Distinct from
   * /agents/:id/actions/log, which is what AUTOPILOT did to one agent.
   * Unfiltered it spans every agent, so an agent-scoped key must ask for its
   * own agent explicitly rather than being handed the whole stream.
   */
  fastifyServer.get<{ Querystring: { agentId?: string; limit?: string } }>(
    '/audit',
    async (request, reply) => {
      const agentId = request.query.agentId;
      const principal = await authorize(
        request,
        reply,
        agentId ? { scope: 'read', agentId } : { scope: 'read', fleetWide: true },
      );
      if (!principal) return;

      const requestedLimit = Number(request.query.limit);
      const limit =
        Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.min(requestedLimit, AUDIT_LIMIT)
          : AUDIT_LIMIT;
      return { events: await store.listAuditEvents(limit, agentId) };
    },
  );

  // Manual control actions from the console. These bypass approval by design —
  // an operator clicking a button in the bearer-gated console IS the human.
  const controlActions = { pause: 'pause_agent', resume: 'resume_agent', rollback: 'rollback' } as const;
  const controlAuditActions = {
    pause: 'control.pause',
    resume: 'control.resume',
    rollback: 'control.rollback',
  } as const;
  for (const [route, action] of Object.entries(controlActions)) {
    fastifyServer.post<{ Params: { agentId: string } }>(
      `/agents/:agentId/control/${route}`,
      async (request, reply) => {
        const principal = await authorize(request, reply, {
          scope: 'control:write',
          agentId: request.params.agentId,
        });
        if (!principal) return;
        const agent = await requireAgent(store, request.params.agentId, reply);
        if (!agent) return;
        const result = await executeControlAction(store, agent.id, action, {
          reason: `manual ${route} from console`,
          actor: principal.label,
          channel: 'console',
          serviceName: agent.serviceName,
        });
        await recordAudit(
          principal,
          {
            action: controlAuditActions[route as keyof typeof controlAuditActions],
            target: agent.id,
            agentId: agent.id,
            summary: `manual ${route}${result.applied ? '' : ' (no-op, already in that state)'}`,
          },
          request.log,
        );
        return { applied: result.applied, state: result.state };
      },
    );
  }

  // --- drift scans: single-agent and fleet-wide ------------------------------

  fastifyServer.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/drift/scan',
    async (request, reply) => {
      const principal = await authorize(request, reply, {
        scope: 'control:write',
        agentId: request.params.agentId,
      });
      if (!principal) return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      try {
        const result = await scheduler.runCycleForAgent(agent.id, 'manual');
        if (result.skipped === 'disabled') {
          return reply.code(503).send({ error: 'drift detection disabled for this agent' });
        }
        if (result.skipped === 'no-metrics-source') {
          return reply
            .code(503)
            .send({ error: 'agent has no metrics source configured; drift detection skipped' });
        }
        await recordAudit(
          principal,
          {
            action: 'drift.scan',
            target: agent.id,
            agentId: agent.id,
            summary: `manual drift scan: ${
              result.report?.verdict
                ? `${result.report.verdict.severity} severity, ${result.intents.length} intent(s)`
                : 'no verdict'
            }`,
          },
          request.log,
        );
        return { verdict: result.report?.verdict, intents: result.intents };
      } catch (error) {
        request.log.error({ error }, 'manual drift scan failed');
        return reply.code(500).send({ error: (error as Error).message });
      }
    },
  );

  fastifyServer.post('/drift/scan', async (request, reply) => {
    const principal = await authorize(request, reply, {
      scope: 'control:write',
      fleetWide: true,
    });
    if (!principal) return;
    try {
      const { results } = await scheduler.runCycle('manual');
      await recordAudit(
        principal,
        { action: 'drift.scan', summary: `manual fleet scan across ${results.length} agent(s)` },
        request.log,
      );
      return { results };
    } catch (error) {
      request.log.error({ error }, 'manual fleet drift scan failed');
      return reply.code(500).send({ error: (error as Error).message });
    }
  });
}
