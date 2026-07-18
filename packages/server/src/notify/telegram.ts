/**
 * Telegram notifier. Sends a message via the Bot API, with an inline keyboard
 * carrying Approve/Reject buttons when an approvalId is present. Button taps
 * arrive as callback_query updates at POST /integrations/telegram/webhook
 * (see routes/integrations.ts) — so approvals work from Telegram on mobile.
 */
import type { NotificationMessage, Notifier } from '@driftwatch/sdk';
import { postJson } from './http.js';

export const TELEGRAM_APPROVE_PREFIX = 'dw_approve:';
export const TELEGRAM_REJECT_PREFIX = 'dw_reject:';

export class TelegramNotifier implements Notifier {
  readonly channel = 'telegram';

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  async notify(message: NotificationMessage): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    await postJson(url, this.render(message));
  }

  private render(message: NotificationMessage): Record<string, unknown> {
    const reasons = message.reasons.length
      ? message.reasons.map((r) => `• ${r}`).join('\n')
      : '_no specific reasons reported_';
    const text =
      `🚨 *${message.title}*\n` +
      `*Severity:* ${message.severity}\n` +
      `*Reasons:*\n${reasons}\n` +
      `*Recommended:* ${message.recommendedAction}`;

    const payload: Record<string, unknown> = {
      chat_id: this.chatId,
      text,
      parse_mode: 'Markdown',
    };

    if (message.approvalId) {
      payload.reply_markup = {
        inline_keyboard: [
          [
            {
              text: '✅ Approve',
              callback_data: `${TELEGRAM_APPROVE_PREFIX}${message.approvalId}`,
            },
            {
              text: '❌ Reject',
              callback_data: `${TELEGRAM_REJECT_PREFIX}${message.approvalId}`,
            },
          ],
        ],
      };
    }

    return payload;
  }
}
