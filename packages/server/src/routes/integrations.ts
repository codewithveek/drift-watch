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
 *
 * The verification/parsing logic itself is framework-agnostic and lives in
 * @driftwatch/autopilot — this file is just the Fastify wiring: reading the
 * raw body/headers and calling those functions.
 */
import type { FastifyInstance } from 'fastify';
import type { ApprovalService, ApprovalDecision, StateStore } from '@driftwatch/sdk';
import {
  verifySlackSignature,
  parseSlackInteraction,
  verifyTelegramSecretToken,
  parseTelegramCallback,
  answerTelegramCallback,
} from '@driftwatch/autopilot';
import type { ServerConfig } from '../config/server-config.js';

export { verifySlackSignature } from '@driftwatch/autopilot';

export interface RegisterIntegrationRoutesOptions {
  approvalService: ApprovalService;
  /**
   * Needed for the tool-call-approval fallback resolution path below — a
   * button tap's id could belong to either a control approval (resolved via
   * approvalService) or a tool-call approval (resolved directly against the
   * store, no executeControlAction involved). See resolveEitherApproval.
   */
  store: StateStore;
  serverConfig: ServerConfig;
}

/**
 * Tries the control-approval resolution path first (approvalService.resolve,
 * which also executes the approved control action); if that id isn't a
 * control approval (returns undefined), falls back to resolving it as a
 * tool-call approval directly against the store. There's no way to know
 * which kind an incoming button-tap id belongs to without checking — both
 * approval kinds render the exact same Approve/Reject buttons and round-trip
 * the same opaque id (see packages/autopilot/src/notifiers/*.ts).
 */
async function resolveEitherApproval(
  approvalService: ApprovalService,
  store: StateStore,
  id: string,
  decision: ApprovalDecision,
  actor: string,
  channel: string,
): Promise<{ kind: 'control'; label: string } | { kind: 'tool_call'; label: string } | undefined> {
  const controlResolved = await approvalService.resolve(id, decision, actor, channel);
  if (controlResolved) return { kind: 'control', label: controlResolved.action };

  const toolCallResolved = await store.resolveToolCallApproval(id, decision, actor, channel);
  if (toolCallResolved) return { kind: 'tool_call', label: toolCallResolved.tool };

  return undefined;
}

export async function registerIntegrationRoutes(
  fastifyServer: FastifyInstance,
  options: RegisterIntegrationRoutesOptions,
): Promise<void> {
  const { approvalService, store, serverConfig } = options;

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
    const resolved = await resolveEitherApproval(approvalService, store, approvalId, decision, actor, 'slack');
    const verb = decision === 'approved' ? 'Approved' : 'Rejected';
    return reply.code(200).send({
      text: resolved
        ? `${verb} — ${resolved.label} (by ${actor})`
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
    if (!verifyTelegramSecretToken(providedToken, serverConfig.telegramSecretToken)) {
      return reply.code(401).send({ error: 'invalid telegram secret token' });
    }

    const callback = parseTelegramCallback(request.body);
    if (!callback) {
      // Not a callback_query update (e.g. a plain message) — nothing to do.
      return reply.code(200).send({ ok: true });
    }

    const { approvalId, decision, actor, callbackQueryId } = callback;
    const resolved = await resolveEitherApproval(
      approvalService,
      store,
      approvalId,
      decision,
      actor,
      'telegram',
    );
    const verb = decision === 'approved' ? 'Approved ✅' : 'Rejected ❌';
    await answerTelegramCallback(
      serverConfig.telegramBotToken,
      callbackQueryId,
      resolved ? `${verb} ${resolved.label}` : 'Already resolved',
    ).catch((error) => request.log.error({ error }, 'answerCallbackQuery failed'));

    return reply.code(200).send({ ok: true });
  });
}

function headerValue(header: string | string[] | undefined): string {
  if (Array.isArray(header)) return header[0] ?? '';
  return header ?? '';
}
