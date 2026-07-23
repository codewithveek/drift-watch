import type { FastifyInstance } from 'fastify';
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
   * the agent to (if any and known), else the primary. Read fresh per request
   * so a switch takes effect on the very next call, and so all processes
   * (which share the store) converge on the same model.
   */
  async function resolveAgentModel(): Promise<ModelClient> {
    const { activeModel } = await store.getAgentState();
    if (activeModel && modelRegistry[activeModel]) return modelRegistry[activeModel];
    return modelClient;
  }

  fastifyServer.get('/health', async () => ({ ok: true }));

  fastifyServer.post<{ Body: { prompt: string } }>(
    '/run',
    {
      config: {
        rateLimit: {
          max: serverConfig.rateLimitMax,
          timeWindow: serverConfig.rateLimitWindowMs,
        },
      },
    },
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply, serverConfig.authToken)) return;

      const promptValidationError = validateRunRequestPrompt(
        request.body?.prompt,
        serverConfig.maxPromptBytes,
      );
      if (promptValidationError) {
        return reply
          .code(promptValidationError.statusCode)
          .send({ error: promptValidationError.message });
      }

      try {
        const agentTaskResult = await runAgentTask({
          prompt: request.body.prompt,
          modelClient: await resolveAgentModel(),
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
        return { output: agentTaskResult.responseText, usage: agentTaskResult };
      } catch (error) {
        request.log.error({ error }, 'agent run failed');
        return reply.code(500).send({ error: (error as Error).message });
      }
    },
  );

  fastifyServer.get(
    '/drift',
    {
      config: {
        rateLimit: {
          max: serverConfig.rateLimitMax,
          timeWindow: serverConfig.rateLimitWindowMs,
        },
      },
    },
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply, serverConfig.authToken)) return;

      try {
        return await detectBehavioralDrift({
          modelClient,
          isDryRun: serverConfig.driftDryRun,
          driftDetectionConfig: driftWatchConfig.driftDetection,
        });
      } catch (error) {
        request.log.error({ error }, 'drift detection failed');
        return reply.code(500).send({ error: (error as Error).message });
      }
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
