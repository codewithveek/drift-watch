/**
 * Slack notifier. Posts a Block Kit message to an incoming webhook. When the
 * message carries an approvalId, it renders Approve/Reject buttons whose
 * clicks Slack delivers to POST /integrations/slack/actions (see
 * routes/integrations.ts) — so a control action can be approved from Slack,
 * including on mobile.
 */
import type { NotificationMessage, Notifier } from '@driftwatch/sdk';
import { postJson } from './http.js';

export const SLACK_APPROVE_ACTION_ID = 'dw_approve';
export const SLACK_REJECT_ACTION_ID = 'dw_reject';

export class SlackNotifier implements Notifier {
  readonly channel = 'slack';

  constructor(private readonly webhookUrl: string) {}

  async notify(message: NotificationMessage): Promise<void> {
    await postJson(this.webhookUrl, this.render(message));
  }

  private render(message: NotificationMessage): Record<string, unknown> {
    const reasons = message.reasons.length
      ? message.reasons.map((r) => `• ${r}`).join('\n')
      : '_no specific reasons reported_';

    const blocks: Record<string, unknown>[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🚨 ${message.title}` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Severity:* ${message.severity}\n*Reasons:*\n${reasons}\n*Recommended:* ${message.recommendedAction}`,
        },
      },
    ];

    if (message.approvalId) {
      blocks.push({
        type: 'actions',
        block_id: `dw_approval:${message.approvalId}`,
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: '✅ Approve' },
            action_id: SLACK_APPROVE_ACTION_ID,
            value: message.approvalId,
          },
          {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: '❌ Reject' },
            action_id: SLACK_REJECT_ACTION_ID,
            value: message.approvalId,
          },
        ],
      });
    }

    return { text: message.title, blocks };
  }
}
