/**
 * Verification + parsing for Telegram's callback_query webhook updates.
 * Framework-agnostic — your HTTP layer reads the request body/headers and
 * hands them to these functions; see docs for a Fastify example.
 */
import { TELEGRAM_APPROVE_PREFIX, TELEGRAM_REJECT_PREFIX } from '../notifiers/telegram.js';
import { constantTimeEqualStrings } from './util.js';

/**
 * Compare the `X-Telegram-Bot-Api-Secret-Token` header against the secret you
 * registered with `setWebhook`, in constant time.
 */
export function verifyTelegramSecretToken(
  providedToken: string,
  expectedToken: string,
): boolean {
  return constantTimeEqualStrings(providedToken, expectedToken);
}

export interface ParsedTelegramCallback {
  approvalId: string;
  decision: 'approved' | 'rejected';
  actor: string;
  callbackQueryId: string;
}

/**
 * Parse a Telegram update body into an approval decision. Returns undefined
 * for updates that aren't an Approve/Reject callback_query (e.g. a plain
 * message) — the caller should treat that as a no-op, not an error.
 */
export function parseTelegramCallback(body: unknown): ParsedTelegramCallback | undefined {
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

/** Acknowledge a callback_query so Telegram stops showing a loading spinner. */
export async function answerTelegramCallback(
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
