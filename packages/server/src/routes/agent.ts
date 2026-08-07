import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import type { ToolSet } from 'ai';
import {
  runAgentTask,
  detectBehavioralDrift,
  type ModelClient,
  type DriftWatchConfig,
  type StateStore,
} from '@driftwatch/sdk';
import type { ServerConfig } from '../config/server-config.js';
import { isRequestAuthorized } from './auth.js';
import { createMetricsQuerySourceFor } from '../config/metrics-source.js';

export interface RegisterRoutesOptions {
  /** Primary/default client — used by the drift judge and when no switch is active. */
  modelClient: ModelClient;
  /** id -> client, for routing the agent to a switched model. */
  modelRegistry: Record<string, ModelClient>;
  /** Shared state; read to see which model Autopilot has the agent switched to. */
  store: StateStore;
  tools: ToolSet;
  serverConfig: ServerConfig;
  driftWatchConfig: DriftWatchConfig;
}

export async function registerRoutes(
  fastifyServer: FastifyInstance,
  options: RegisterRoutesOptions,
): Promise<void> {
  const { modelClient, modelRegistry, store, tools, serverConfig, driftWatchConfig } =
    options;

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
    return runAgentTask({
      prompt,
      modelClient: await resolveAgentModel(agentId),
      tools,
      maxSteps: driftWatchConfig.agent.maxSteps,
      guardrails: {
        maxTokensPerTask: driftWatchConfig.agent.maxTokensPerTask,
        maxCostUsd: driftWatchConfig.agent.maxCostUsd,
        pricePer1kInput: driftWatchConfig.agent.pricePer1kInput,
        pricePer1kOutput: driftWatchConfig.agent.pricePer1kOutput,
        onExceed: driftWatchConfig.agent.onExceed,
      },
    });
  }

  async function runDrift(agentId: string) {
    const agent = await store.getAgentDefinition(agentId);
    const metricsQuerySource = agent
      ? createMetricsQuerySourceFor(driftWatchConfig.driftDetection, agent)
      : undefined;
    return detectBehavioralDrift({
      modelClient,
      isDryRun: serverConfig.driftDryRun,
      metricsQuerySource,
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
      reply.log.error({ error }, 'agent run failed');
      return reply.code(500).send({ error: (error as Error).message });
    }
  }

  async function handleDrift(agentId: string, reply: FastifyReply, log: FastifyBaseLogger) {
    try {
      return await runDrift(agentId);
    } catch (error) {
      log.error({ error }, 'drift detection failed');
      return reply.code(500).send({ error: (error as Error).message });
    }
  }

  // Bare /run resolves to this server's auto-registered default agent — kept
  // as an alias so anything integrated against the pre-fleet single-agent API
  // keeps working unmodified. New integrations should use the agentId-scoped
  // route directly.
  fastifyServer.post<{ Body: { prompt: string } }>('/run', runRateLimit, async (request, reply) => {
    if (!isRequestAuthorized(request, reply, serverConfig.authToken)) return;
    return handleRun(serverConfig.agentId, request.body?.prompt, reply);
  });

  fastifyServer.post<{ Params: { agentId: string }; Body: { prompt: string } }>(
    '/agents/:agentId/run',
    runRateLimit,
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply, serverConfig.authToken)) return;
      return handleRun(request.params.agentId, request.body?.prompt, reply);
    },
  );

  fastifyServer.get('/drift', runRateLimit, async (request, reply) => {
    if (!isRequestAuthorized(request, reply, serverConfig.authToken)) return;
    return handleDrift(serverConfig.agentId, reply, request.log);
  });

  fastifyServer.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/drift',
    runRateLimit,
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply, serverConfig.authToken)) return;
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
