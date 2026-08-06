/**
 * Verification + parsing for Slack's Interactivity callbacks. Framework-
 * agnostic — your HTTP layer is responsible for reading the raw request body
 * and headers and handing them to these functions; see docs for a Fastify
 * example.
 */
import { createHmac } from 'node:crypto';
import { SLACK_APPROVE_ACTION_ID } from '../notifiers/slack.js';
import { constantTimeEqualStrings } from './util.js';

const SLACK_TIMESTAMP_TOLERANCE_SEC = 300;

/**
 * Verify Slack's v0 signature: HMAC-SHA256 of `v0:{ts}:{body}` with the signing
 * secret, compared in constant time. Also rejects stale timestamps to defeat
 * replay attacks. `rawBody` MUST be the exact bytes Slack sent — any
 * re-serialization changes what the HMAC covers.
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

export interface ParsedSlackInteraction {
  approvalId: string;
  decision: 'approved' | 'rejected';
  actor: string;
}

/** Parse a verified Slack interactive-message form body into a decision. */
export function parseSlackInteraction(
  rawBody: string,
): ParsedSlackInteraction | undefined {
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
