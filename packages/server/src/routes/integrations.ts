/**
 * Integration webhooks — the "approve from anywhere" surface.
 *
 * These routes are NOT bearer-gated like the console API. Each carries its own
 * provider-specific auth:
 *   - Slack: HMAC over the raw body (X-Slack-Signature) + a 5-minute timestamp
 *     window to defeat replays.
 *   - Telegram: a shared secret token echoed in a header we set when we
 *     registered the webhook.
 * Both resolve the SAME shared approval as the console, so a tap on a phone and
 * a click in the console are interchangeable and idempotent.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ApprovalService } from '../autopilot/approval-service.js';
import type { ServerConfig } from '../config/server-config.js';
import { SLACK_APPROVE_ACTION_ID } from '../notify/slack.js';
import { TELEGRAM_APPROVE_PREFIX, TELEGRAM_REJECT_PREFIX } from '../notify/telegram.js';

const SLACK_TIMESTAMP_TOLERANCE_SEC = 300;

export interface RegisterIntegrationRoutesOptions {
  approvalService: ApprovalService;
  serverConfig: ServerConfig;
}

export async function registerIntegrationRoutes(
  fastifyServer: FastifyInstance,
  options: RegisterIntegrationRoutesOptions,
): Promise<void> {
  const { approvalService, serverConfig } = options;

  // Slack sends interactions as application/x-www-form-urlencoded. We need the
  // RAW body to verify the signature, so keep it as a string and parse by hand.
  fastifyServer.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );

  fastifyServer.post('/integrations/slack/actions', async (request, reply) => {
    if (!serverConfig.slackSigningSecret) {
      return reply.code(503).send({ error: 'slack integration not configured' });
    }

    const rawBody = typeof request.body === 'string' ? request.body : '';
    const signature = headerValue(request.headers['x-slack-signature']);
    const timestamp = headerValue(request.headers['x-slack-request-timestamp']);

    if (
      !verifySlackSignature(
        rawBody,
        timestamp,
        signature,
        serverConfig.slackSigningSecret,
      )
    ) {
      return reply.code(401).send({ error: 'invalid slack signature' });
    }

    const interaction = parseSlackInteraction(rawBody);
    if (!interaction) {
      return reply.code(400).send({ error: 'malformed interaction payload' });
    }

    const { approvalId, decision, actor } = interaction;
    const resolved = await approvalService.resolve(approvalId, decision, actor, 'slack');
    const verb = decision === 'approved' ? 'Approved' : 'Rejected';
    return reply.code(200).send({
      text: resolved
        ? `${verb} — ${resolved.action} (by ${actor})`
        : 'Already resolved.',
    });
  });

  fastifyServer.post('/integrations/telegram/webhook', async (request, reply) => {
    if (!serverConfig.telegramBotToken || !serverConfig.telegramSecretToken) {
      return reply.code(503).send({ error: 'telegram integration not configured' });
    }

    const providedToken = headerValue(
      request.headers['x-telegram-bot-api-secret-token'],
    );
    if (!constantTimeEqualStrings(providedToken, serverConfig.telegramSecretToken)) {
      return reply.code(401).send({ error: 'invalid telegram secret token' });
    }

    const callback = parseTelegramCallback(request.body);
    if (!callback) {
      // Not a callback_query update (e.g. a plain message) — nothing to do.
      return reply.code(200).send({ ok: true });
    }

    const { approvalId, decision, actor, callbackQueryId } = callback;
    const resolved = await approvalService.resolve(
      approvalId,
      decision,
      actor,
      'telegram',
    );
    const verb = decision === 'approved' ? 'Approved ✅' : 'Rejected ❌';
    await answerTelegramCallback(
      serverConfig.telegramBotToken,
      callbackQueryId,
      resolved ? `${verb} ${resolved.action}` : 'Already resolved',
    ).catch((error) => request.log.error({ error }, 'answerCallbackQuery failed'));

    return reply.code(200).send({ ok: true });
  });
}

function headerValue(header: string | string[] | undefined): string {
  if (Array.isArray(header)) return header[0] ?? '';
  return header ?? '';
}

/**
 * Verify Slack's v0 signature: HMAC-SHA256 of `v0:{ts}:{body}` with the signing
 * secret, compared in constant time. Also rejects stale timestamps to defeat
 * replay attacks.
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  if (!timestamp || !signature) return false;

  const timestampSec = Number(timestamp);
  if (!Number.isFinite(timestampSec)) return false;
  const skewSec = Math.abs(Date.now() / 1000 - timestampSec);
  if (skewSec > SLACK_TIMESTAMP_TOLERANCE_SEC) return false;

  const expected =
    'v0=' +
    createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex');

  return constantTimeEqualStrings(signature, expected);
}

interface ParsedInteraction {
  approvalId: string;
  decision: 'approved' | 'rejected';
  actor: string;
}

function parseSlackInteraction(rawBody: string): ParsedInteraction | undefined {
  try {
    const payloadJson = new URLSearchParams(rawBody).get('payload');
    if (!payloadJson) return undefined;
    const payload = JSON.parse(payloadJson) as {
      user?: { id?: string; username?: string };
      actions?: { action_id?: string; value?: string }[];
    };
    const action = payload.actions?.[0];
    if (!action?.action_id || !action.value) return undefined;

    return {
      approvalId: action.value,
      decision: action.action_id === SLACK_APPROVE_ACTION_ID ? 'approved' : 'rejected',
      actor: payload.user?.username || payload.user?.id || 'slack-user',
    };
  } catch {
    return undefined;
  }
}

interface ParsedTelegramCallback extends ParsedInteraction {
  callbackQueryId: string;
}

function parseTelegramCallback(body: unknown): ParsedTelegramCallback | undefined {
  const update = body as {
    callback_query?: {
      id?: string;
      data?: string;
      from?: { id?: number; username?: string };
    };
  };
  const callbackQuery = update?.callback_query;
  if (!callbackQuery?.id || !callbackQuery.data) return undefined;

  const data = callbackQuery.data;
  let decision: 'approved' | 'rejected';
  let approvalId: string;
  if (data.startsWith(TELEGRAM_APPROVE_PREFIX)) {
    decision = 'approved';
    approvalId = data.slice(TELEGRAM_APPROVE_PREFIX.length);
  } else if (data.startsWith(TELEGRAM_REJECT_PREFIX)) {
    decision = 'rejected';
    approvalId = data.slice(TELEGRAM_REJECT_PREFIX.length);
  } else {
    return undefined;
  }

  return {
    approvalId,
    decision,
    actor:
      callbackQuery.from?.username ||
      (callbackQuery.from?.id ? String(callbackQuery.from.id) : 'telegram-user'),
    callbackQueryId: callbackQuery.id,
  };
}

async function answerTelegramCallback(
  botToken: string,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

/** Length-safe constant-time string comparison. */
function constantTimeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
