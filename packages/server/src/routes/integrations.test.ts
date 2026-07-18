import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ActionIntent } from '@driftwatch/sdk';
import {
  registerIntegrationRoutes,
  verifySlackSignature,
} from './integrations.js';
import { ServerConfigSchema, type ServerConfig } from '../config/server-config.js';
import { MemoryStateStore } from '../state/memory-store.js';
import { ApprovalService } from '../autopilot/approval-service.js';

const SIGNING_SECRET = 'test-signing-secret';
const TELEGRAM_SECRET = 'test-telegram-secret';
const TELEGRAM_TOKEN = 'test-bot-token';

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return ServerConfigSchema.parse({
    slackSigningSecret: SIGNING_SECRET,
    telegramBotToken: TELEGRAM_TOKEN,
    telegramSecretToken: TELEGRAM_SECRET,
    ...overrides,
  });
}

function controlIntent(): ActionIntent {
  return { type: 'pause_agent', category: 'control', severity: 'high', reason: 'spike' };
}

/** Build a valid Slack interactive-message form body + its signature header. */
function signedSlackRequest(approvalId: string, actionId: string, secret = SIGNING_SECRET) {
  const payload = JSON.stringify({
    user: { username: 'alice' },
    actions: [{ action_id: actionId, value: approvalId }],
  });
  const body = `payload=${encodeURIComponent(payload)}`;
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature =
    'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return { body, ts, signature };
}

let app: FastifyInstance | undefined;

async function buildApp(config: ServerConfig) {
  const store = new MemoryStateStore();
  const approvalService = new ApprovalService({
    store,
    notifiers: { list: [] },
    approvalTimeoutMs: 60_000,
    timeoutDecision: 'rejected',
  });
  const fastify = Fastify({ logger: false });
  await registerIntegrationRoutes(fastify, { approvalService, serverConfig: config });
  await fastify.ready();
  app = fastify;
  return { fastify, store, approvalService };
}

describe('verifySlackSignature', () => {
  const body = 'payload=%7B%7D';
  const ts = Math.floor(Date.now() / 1000).toString();
  const good =
    'v0=' + createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex');

  it('accepts a correctly signed, fresh request', () => {
    expect(verifySlackSignature(body, ts, good, SIGNING_SECRET)).toBe(true);
  });

  it('rejects a forged signature', () => {
    expect(verifySlackSignature(body, ts, 'v0=deadbeef', SIGNING_SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const wrong =
      'v0=' + createHmac('sha256', 'other-secret').update(`v0:${ts}:${body}`).digest('hex');
    expect(verifySlackSignature(body, ts, wrong, SIGNING_SECRET)).toBe(false);
  });

  it('rejects a stale timestamp outside the replay window', () => {
    const staleTs = (Math.floor(Date.now() / 1000) - 3600).toString();
    const sig =
      'v0=' + createHmac('sha256', SIGNING_SECRET).update(`v0:${staleTs}:${body}`).digest('hex');
    expect(verifySlackSignature(body, staleTs, sig, SIGNING_SECRET)).toBe(false);
  });

  it('rejects when timestamp or signature is missing', () => {
    expect(verifySlackSignature(body, '', good, SIGNING_SECRET)).toBe(false);
    expect(verifySlackSignature(body, ts, '', SIGNING_SECRET)).toBe(false);
  });
});

describe('POST /integrations/slack/actions', () => {
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('resolves the shared approval on a valid signed Approve', async () => {
    const { fastify, store, approvalService } = await buildApp(serverConfig());
    const approval = await approvalService.requestApproval(controlIntent());
    const { body, ts, signature } = signedSlackRequest(approval.id, 'dw_approve');

    const res = await fastify.inject({
      method: 'POST',
      url: '/integrations/slack/actions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-signature': signature,
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    // Approving pause_agent through Slack mutates the SHARED store.
    expect((await store.getAgentState()).status).toBe('paused');
    expect(await store.listPendingApprovals()).toHaveLength(0);
  });

  it('rejects a forged signature with 401 and does not resolve', async () => {
    const { fastify, store, approvalService } = await buildApp(serverConfig());
    const approval = await approvalService.requestApproval(controlIntent());
    const { body, ts } = signedSlackRequest(approval.id, 'dw_approve');

    const res = await fastify.inject({
      method: 'POST',
      url: '/integrations/slack/actions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-signature': 'v0=forged',
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect((await store.getAgentState()).status).toBe('running');
    expect(await store.listPendingApprovals()).toHaveLength(1);
  });

  it('returns 503 when Slack is not configured', async () => {
    const { fastify } = await buildApp(serverConfig({ slackSigningSecret: '' }));
    const { body, ts, signature } = signedSlackRequest('missing', 'dw_approve');

    const res = await fastify.inject({
      method: 'POST',
      url: '/integrations/slack/actions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-signature': signature,
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(503);
  });
});

describe('POST /integrations/telegram/webhook', () => {
  beforeEach(() => {
    // answerCallbackQuery hits the Telegram API — stub it so tests stay hermetic.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    app = undefined;
  });

  it('resolves the approval when the secret-token header matches', async () => {
    const { fastify, store, approvalService } = await buildApp(serverConfig());
    const approval = await approvalService.requestApproval(controlIntent());

    const res = await fastify.inject({
      method: 'POST',
      url: '/integrations/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
      payload: {
        callback_query: {
          id: 'cbq-1',
          data: `dw_approve:${approval.id}`,
          from: { username: 'bob' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect((await store.getAgentState()).status).toBe('paused');
  });

  it('rejects a wrong secret token with 401', async () => {
    const { fastify, store, approvalService } = await buildApp(serverConfig());
    const approval = await approvalService.requestApproval(controlIntent());

    const res = await fastify.inject({
      method: 'POST',
      url: '/integrations/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-token' },
      payload: {
        callback_query: { id: 'cbq-1', data: `dw_approve:${approval.id}`, from: {} },
      },
    });

    expect(res.statusCode).toBe(401);
    expect((await store.getAgentState()).status).toBe('running');
  });
});
