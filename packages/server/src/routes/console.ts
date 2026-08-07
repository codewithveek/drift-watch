/**
 * Control-plane API — the bearer-gated surface the React console (and any
 * operator script) talks to. Reuses the exact same isRequestAuthorized gate as
 * /run and /drift, so there is one auth story for the whole control plane.
 *
 * Everything here reads/writes the SHARED StateStore, so the console, Slack,
 * and Telegram always see the same truth. Every route except /agents itself
 * (list + register) is scoped to one agent via an :agentId path param, and
 * 404s early if that agent isn't registered — see requireAgent below.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  AgentDefinition,
  DriftWatchConfig,
  StateStore,
  ApprovalService,
  AutopilotScheduler,
} from '@driftwatch/sdk';
import { AGENT_ID_PATTERN, executeControlAction } from '@driftwatch/sdk';
import type { ServerConfig } from '../config/server-config.js';
import { isRequestAuthorized } from './auth.js';

const HISTORY_LIMIT = 100;

export interface RegisterConsoleRoutesOptions {
  store: StateStore;
  serverConfig: ServerConfig;
  driftWatchConfig: DriftWatchConfig;
  approvalService: ApprovalService;
  /** Present only when autopilot is enabled; gates the manual scan trigger. */
  scheduler?: AutopilotScheduler;
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

export async function registerConsoleRoutes(
  fastifyServer: FastifyInstance,
  options: RegisterConsoleRoutesOptions,
): Promise<void> {
  const { store, serverConfig, driftWatchConfig, approvalService, scheduler } = options;
  const authToken = serverConfig.authToken;

  // --- agent registry -------------------------------------------------------

  fastifyServer.get('/agents', async (request, reply) => {
    if (!isRequestAuthorized(request, reply, authToken)) return;
    return { agents: await store.listAgents() };
  });

  fastifyServer.post<{
    Body: { id?: string; name?: string; owner?: string; serviceName?: string };
  }>('/agents', async (request, reply) => {
    if (!isRequestAuthorized(request, reply, authToken)) return;

    const { name, owner, serviceName } = request.body ?? {};
    if (!name) {
      return reply.code(400).send({ error: 'name (string) required' });
    }
    const id = request.body?.id || randomUUID();
    if (!AGENT_ID_PATTERN.test(id)) {
      return reply.code(400).send({ error: 'id must match ^[a-zA-Z0-9_-]+$' });
    }

    const definition: AgentDefinition = { id, name, owner, serviceName, createdAt: Date.now() };
    await store.upsertAgent(definition);
    return reply.code(201).send({ agent: definition });
  });

  // --- per-agent state/history/approvals/log --------------------------------

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/state',
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply, authToken)) return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      return {
        agent: await store.getAgentState(agent.id),
        autopilot: {
          enabled: serverConfig.autopilotEnabled,
          mode: serverConfig.autopilotMode,
          scanIntervalMs: serverConfig.scanIntervalMs,
        },
        guardrails: {
          maxTokensPerTask: driftWatchConfig.agent.maxTokensPerTask,
          maxCostUsd: driftWatchConfig.agent.maxCostUsd,
          onExceed: driftWatchConfig.agent.onExceed,
        },
      };
    },
  );

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/drift/history',
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply, authToken)) return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      return { history: await store.listDriftHistory(agent.id, HISTORY_LIMIT) };
    },
  );

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/approvals',
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply, authToken)) return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      return { approvals: await store.listPendingApprovals(agent.id) };
    },
  );

  fastifyServer.post<{
    Params: { agentId: string; id: string };
    Body: { decision?: string; actor?: string };
  }>('/agents/:agentId/approvals/:id/resolve', async (request, reply) => {
    if (!isRequestAuthorized(request, reply, authToken)) return;
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
    return { approval: resolved };
  });

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/actions/log',
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply, authToken)) return;
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      return { log: await store.listActionLog(agent.id, HISTORY_LIMIT) };
    },
  );

  // Manual control actions from the console. These bypass approval by design —
  // an operator clicking a button in the bearer-gated console IS the human.
  const controlActions = { pause: 'pause_agent', resume: 'resume_agent', rollback: 'rollback' } as const;
  for (const [route, action] of Object.entries(controlActions)) {
    fastifyServer.post<{ Params: { agentId: string } }>(
      `/agents/:agentId/control/${route}`,
      async (request, reply) => {
        if (!isRequestAuthorized(request, reply, authToken)) return;
        const agent = await requireAgent(store, request.params.agentId, reply);
        if (!agent) return;
        const result = await executeControlAction(store, agent.id, action, {
          reason: `manual ${route} from console`,
          actor: 'console',
          channel: 'console',
          serviceName: agent.serviceName,
        });
        return { applied: result.applied, state: result.state };
      },
    );
  }

  // --- drift scans: single-agent and fleet-wide ------------------------------

  fastifyServer.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/drift/scan',
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply, authToken)) return;
      if (!scheduler) {
        return reply.code(503).send({ error: 'autopilot disabled; scan unavailable' });
      }
      const agent = await requireAgent(store, request.params.agentId, reply);
      if (!agent) return;
      try {
        const result = await scheduler.runCycleForAgent(agent.id, 'manual');
        if (result.skipped) {
          return reply
            .code(503)
            .send({ error: 'agent has no serviceName registered; drift detection skipped' });
        }
        return { verdict: result.report?.verdict, intents: result.intents };
      } catch (error) {
        request.log.error({ error }, 'manual drift scan failed');
        return reply.code(500).send({ error: (error as Error).message });
      }
    },
  );

  fastifyServer.post('/drift/scan', async (request, reply) => {
    if (!isRequestAuthorized(request, reply, authToken)) return;
    if (!scheduler) {
      return reply.code(503).send({ error: 'autopilot disabled; scan unavailable' });
    }
    try {
      const { results } = await scheduler.runCycle('manual');
      return { results };
    } catch (error) {
      request.log.error({ error }, 'manual fleet drift scan failed');
      return reply.code(500).send({ error: (error as Error).message });
    }
  });
}
