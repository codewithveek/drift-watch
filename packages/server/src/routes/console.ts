/**
 * Control-plane API — the bearer-gated surface the React console (and any
 * operator script) talks to. Reuses the exact same isRequestAuthorized gate as
 * /run and /drift, so there is one auth story for the whole control plane.
 *
 * Everything here reads/writes the SHARED StateStore, so the console, Slack,
 * and Telegram always see the same truth.
 */
import type { FastifyInstance } from 'fastify';
import type { DriftWatchConfig, StateStore, ApprovalService, AutopilotScheduler } from '@driftwatch/sdk';
import { executeControlAction } from '@driftwatch/sdk';
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

export async function registerConsoleRoutes(
  fastifyServer: FastifyInstance,
  options: RegisterConsoleRoutesOptions,
): Promise<void> {
  const { store, serverConfig, driftWatchConfig, approvalService, scheduler } = options;
  const authToken = serverConfig.authToken;

  fastifyServer.get('/state', async (request, reply) => {
    if (!isRequestAuthorized(request, reply, authToken)) return;
    return {
      agent: await store.getAgentState(),
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
  });

  fastifyServer.get('/drift/history', async (request, reply) => {
    if (!isRequestAuthorized(request, reply, authToken)) return;
    return { history: await store.listDriftHistory(HISTORY_LIMIT) };
  });

  fastifyServer.get('/approvals', async (request, reply) => {
    if (!isRequestAuthorized(request, reply, authToken)) return;
    return { approvals: await store.listPendingApprovals() };
  });

  fastifyServer.post<{ Params: { id: string }; Body: { decision?: string; actor?: string } }>(
    '/approvals/:id/resolve',
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply, authToken)) return;

      const decision = request.body?.decision;
      if (decision !== 'approved' && decision !== 'rejected') {
        return reply.code(400).send({ error: "decision must be 'approved' or 'rejected'" });
      }
      const actor = request.body?.actor || 'console';
      const resolved = await approvalService.resolve(
        request.params.id,
        decision,
        actor,
        'console',
      );
      if (!resolved) {
        return reply.code(409).send({ error: 'approval missing or already resolved' });
      }
      return { approval: resolved };
    },
  );

  fastifyServer.get('/actions/log', async (request, reply) => {
    if (!isRequestAuthorized(request, reply, authToken)) return;
    return { log: await store.listActionLog(HISTORY_LIMIT) };
  });

  // Manual control actions from the console. These bypass approval by design —
  // an operator clicking a button in the bearer-gated console IS the human.
  const controlActions = { pause: 'pause_agent', resume: 'resume_agent', rollback: 'rollback' } as const;
  for (const [route, action] of Object.entries(controlActions)) {
    fastifyServer.post(`/control/${route}`, async (request, reply) => {
      if (!isRequestAuthorized(request, reply, authToken)) return;
      const result = await executeControlAction(store, action, {
        reason: `manual ${route} from console`,
        actor: 'console',
        channel: 'console',
      });
      return { applied: result.applied, state: result.state };
    });
  }

  fastifyServer.post('/drift/scan', async (request, reply) => {
    if (!isRequestAuthorized(request, reply, authToken)) return;
    if (!scheduler) {
      return reply.code(503).send({ error: 'autopilot disabled; scan unavailable' });
    }
    try {
      const { report, intents } = await scheduler.runCycle('manual');
      return { verdict: report.verdict, intents };
    } catch (error) {
      request.log.error({ error }, 'manual drift scan failed');
      return reply.code(500).send({ error: (error as Error).message });
    }
  });
}
