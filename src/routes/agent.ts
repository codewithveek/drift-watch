import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { runAgentTask } from '../agent/runner.js';
import { detectBehavioralDrift } from '../drift/detector.js';
import type { ModelClient } from '../agent/model-client.js';

const configuredAuthToken = process.env.AUTH_TOKEN ?? '';
const maximumPromptSizeBytes = Number(process.env.MAX_PROMPT_BYTES ?? 8192);

export interface RegisterRoutesOptions {
  modelClient: ModelClient;
}

export async function registerRoutes(
  fastifyServer: FastifyInstance,
  options: RegisterRoutesOptions,
): Promise<void> {
  const { modelClient } = options;

  fastifyServer.get('/health', async () => ({ ok: true }));

  fastifyServer.post<{ Body: { prompt: string } }>(
    '/run',
    async (request, reply) => {
      if (!isRequestAuthorized(request, reply)) return;

      const promptValidationError = validateRunRequestPrompt(request.body?.prompt);
      if (promptValidationError) {
        return reply
          .code(promptValidationError.statusCode)
          .send({ error: promptValidationError.message });
      }

      try {
        const agentTaskResult = await runAgentTask({
          prompt: request.body.prompt,
          modelClient,
        });
        return { output: agentTaskResult.responseText, usage: agentTaskResult };
      } catch (error) {
        request.log.error({ error }, 'agent run failed');
        return reply.code(500).send({ error: (error as Error).message });
      }
    },
  );

  fastifyServer.get('/drift', async (request, reply) => {
    if (!isRequestAuthorized(request, reply)) return;

    try {
      return await detectBehavioralDrift({
        modelClient,
        isDryRun: process.env.DRIFT_DRY_RUN === '1',
      });
    } catch (error) {
      request.log.error({ error }, 'drift detection failed');
      return reply.code(500).send({ error: (error as Error).message });
    }
  });
}

interface PromptValidationError {
  statusCode: number;
  message: string;
}

function validateRunRequestPrompt(
  prompt: unknown,
): PromptValidationError | undefined {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { statusCode: 400, message: 'prompt (string) required' };
  }
  if (Buffer.byteLength(prompt, 'utf8') > maximumPromptSizeBytes) {
    return {
      statusCode: 413,
      message: `prompt exceeds MAX_PROMPT_BYTES=${maximumPromptSizeBytes}`,
    };
  }
  return undefined;
}

/**
 * Bearer-token gate. When AUTH_TOKEN is unset (dev), we still refuse traffic
 * from anywhere but the local network — model tokens cost money, and this
 * app has zero auth otherwise. Setting AUTH_TOKEN opens it up to any client
 * that presents the matching bearer.
 */
function isRequestAuthorized(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (configuredAuthToken) {
    if (isRequestBearerTokenValid(request)) return true;
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }

  if (isRequestFromLocalNetwork(request)) return true;
  reply.code(401).send({
    error:
      'AUTH_TOKEN not configured; remote requests are refused. Set AUTH_TOKEN=<secret> to enable.',
  });
  return false;
}

function isRequestBearerTokenValid(request: FastifyRequest): boolean {
  const authorizationHeader = request.headers.authorization ?? '';
  const [authScheme, bearerToken] = authorizationHeader.split(' ');
  return authScheme === 'Bearer' && bearerToken === configuredAuthToken;
}

function isRequestFromLocalNetwork(request: FastifyRequest): boolean {
  const clientIpAddress = request.ip;
  return (
    clientIpAddress === '127.0.0.1' ||
    clientIpAddress === '::1' ||
    clientIpAddress === '::ffff:127.0.0.1' ||
    clientIpAddress.startsWith('10.') ||
    clientIpAddress.startsWith('192.168.') ||
    clientIpAddress.startsWith('172.')
  );
}
