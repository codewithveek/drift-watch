import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import {
  createAgentRuntime,
  runAgentTask,
  detectBehavioralDrift,
  resolveAgentConfig,
  toAgentGuardrails,
  type ModelClient,
  type DriftWatchConfig,
  type StateStore,
  type NotifierRegistry,
} from '@driftwatch/sdk';
import type { ServerConfig } from '../config/server-config.js';
import { getEffectiveAgent } from '../state/effective-agent.js';
import type { AuthorizeFn } from './auth.js';
import { createMetricsQuerySourceFor } from '../config/metrics-source.js';
import { buildAgentTools } from '../tools.js';

export interface RegisterRoutesOptions {
  /** Primary/default client — used by the drift judge and when no switch is active. */
  modelClient: ModelClient;
  /** id -> client, for routing the agent to a switched model. */
  modelRegistry: Record<string, ModelClient>;
  /** Shared state; read to see which model Autopilot has the agent switched to. */
  store: StateStore;
  serverConfig: ServerConfig;
  driftWatchConfig: DriftWatchConfig;
  /** For notifying pending tool-call approvals (Loop 3) — same registry Autopilot uses. */
  notifiers: NotifierRegistry;
  /** How long a pre-execution tool-call approval waits before toolCallApprovalTimeoutDecision applies. */
  toolCallApprovalTimeoutMs: number;
  toolCallApprovalTimeoutDecision: 'approved' | 'rejected';
  /** Shared scope/agent-aware gate — see routes/auth.ts. */
  authorize: AuthorizeFn;
}

/** Thrown when an :agentId route param (or the auto-registered default) isn't registered. */
class AgentNotFoundError extends Error {
  constructor(readonly agentId: string) {
    super(`unknown agent: ${agentId}`);
  }
}

export async function registerRoutes(
  fastifyServer: FastifyInstance,
  options: RegisterRoutesOptions,
): Promise<void> {
  const {
    modelClient,
    modelRegistry,
    store,
    serverConfig,
    driftWatchConfig,
    notifiers,
    toolCallApprovalTimeoutMs,
    toolCallApprovalTimeoutDecision,
    authorize,
  } = options;

  /**
   * Pick the client for the next agent run: the model Autopilot has switched
   * this agent to (if any and known), else the primary. Read fresh per request
   * so a switch takes effect on the very next call, and so all processes
   * (which share the store) converge on the same model.
   */
  async function resolveAgentModel(agentId: string): Promise<ModelClient> {
    const { activeModel } = await store.getAgentState(agentId);
    if (activeModel && modelRegistry[activeModel]) return modelRegistry[activeModel];
    return modelClient;
  }

  async function runTask(agentId: string, prompt: string) {
    // Effective, not baseline: an operator's console override must govern the
    // very next run, which is the entire promise of live editing.
    const agent = await getEffectiveAgent(store, agentId);
    if (!agent) throw new AgentNotFoundError(agentId);

    const sourceAgent = agent.guardrailsSource
      ? await store.getAgentDefinition(agent.guardrailsSource)
      : undefined;
    const resolvedConfig = resolveAgentConfig(agent, driftWatchConfig, sourceAgent);

    // The runtime is used here ONLY to wrap tools with this agent's span +
    // policy gate (see buildAgentTools). The run itself deliberately stays on
    // `runAgentTask` rather than `runtime.run()`: this file has concerns the
    // facade shouldn't absorb — 404-on-unknown-agent, model switching, and
    // the dual guardrailsSource/toolPoliciesSource lookups — and keeping the
    // primitive path here means it stays exercised by real code instead of
    // rotting behind the convenience layer.
    //
    // A resolver (not a snapshot) so tool policies are re-read from the store
    // on every call — that's what makes a control-plane PATCH apply to the
    // very next run with no restart and no cache to invalidate.
    const runtime = createAgentRuntime({
      agent: async () => (await getEffectiveAgent(store, agentId)) ?? agent,
      config: driftWatchConfig,
      store,
      notifiers,
      approvalTimeoutMs: toolCallApprovalTimeoutMs,
      timeoutDecision: toolCallApprovalTimeoutDecision,
    });

    return runAgentTask({
      prompt,
      modelClient: await resolveAgentModel(agentId),
      tools: buildAgentTools({ runtime, toolNames: agent.toolNames }),
      maxSteps: resolvedConfig.maxSteps,
      guardrails: toAgentGuardrails(resolvedConfig),
      agentId,
      serviceName: agent.serviceName,
    });
  }

  async function runDrift(agentId: string) {
    const agent = await getEffectiveAgent(store, agentId);
    if (!agent) throw new AgentNotFoundError(agentId);

    const metricsQuerySource = createMetricsQuerySourceFor(driftWatchConfig.driftDetection, agent);
    return detectBehavioralDrift({
      modelClient,
      isDryRun: serverConfig.driftDryRun,
      metricsQuerySource,
      agentId,
      serviceName: agent.serviceName,
    });
  }

  fastifyServer.get('/health', async () => ({ ok: true }));

  const runRateLimit = {
    config: {
      rateLimit: {
        max: serverConfig.rateLimitMax,
        timeWindow: serverConfig.rateLimitWindowMs,
      },
    },
  };

  async function handleRun(agentId: string, prompt: unknown, reply: FastifyReply) {
    const promptValidationError = validateRunRequestPrompt(prompt, serverConfig.maxPromptBytes);
    if (promptValidationError) {
      return reply
        .code(promptValidationError.statusCode)
        .send({ error: promptValidationError.message });
    }

    try {
      const agentTaskResult = await runTask(agentId, prompt as string);
      return { output: agentTaskResult.responseText, usage: agentTaskResult };
    } catch (error) {
      if (error instanceof AgentNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      reply.log.error({ error }, 'agent run failed');
      return reply.code(500).send({ error: (error as Error).message });
    }
  }

  async function handleDrift(agentId: string, reply: FastifyReply, log: FastifyBaseLogger) {
    try {
      return await runDrift(agentId);
    } catch (error) {
      if (error instanceof AgentNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      log.error({ error }, 'drift detection failed');
      return reply.code(500).send({ error: (error as Error).message });
    }
  }

  // Bare /run resolves to this server's auto-registered default agent — kept
  // as an alias so anything integrated against the pre-fleet single-agent API
  // keeps working unmodified. New integrations should use the agentId-scoped
  // route directly.
  fastifyServer.post<{ Body: { prompt: string } }>('/run', runRateLimit, async (request, reply) => {
    const requirement = { scope: 'agent:run', agentId: serverConfig.agentId } as const;
    if (!(await authorize(request, reply, requirement))) return;
    return handleRun(serverConfig.agentId, request.body?.prompt, reply);
  });

  fastifyServer.post<{ Params: { agentId: string }; Body: { prompt: string } }>(
    '/agents/:agentId/run',
    runRateLimit,
    async (request, reply) => {
      const requirement = { scope: 'agent:run', agentId: request.params.agentId } as const;
      if (!(await authorize(request, reply, requirement))) return;
      return handleRun(request.params.agentId, request.body?.prompt, reply);
    },
  );

  fastifyServer.get('/drift', runRateLimit, async (request, reply) => {
    const requirement = { scope: 'agent:run', agentId: serverConfig.agentId } as const;
    if (!(await authorize(request, reply, requirement))) return;
    return handleDrift(serverConfig.agentId, reply, request.log);
  });

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/drift',
    runRateLimit,
    async (request, reply) => {
      const requirement = { scope: 'agent:run', agentId: request.params.agentId } as const;
      if (!(await authorize(request, reply, requirement))) return;
      return handleDrift(request.params.agentId, reply, request.log);
    },
  );
}

interface PromptValidationError {
  statusCode: number;
  message: string;
}

function validateRunRequestPrompt(
  prompt: unknown,
  maxPromptBytes: number,
): PromptValidationError | undefined {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { statusCode: 400, message: 'prompt (string) required' };
  }
  if (Buffer.byteLength(prompt, 'utf8') > maxPromptBytes) {
    return {
      statusCode: 413,
      message: `prompt exceeds MAX_PROMPT_BYTES=${maxPromptBytes}`,
    };
  }
  return undefined;
}
