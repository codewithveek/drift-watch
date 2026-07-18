/**
 * Generic webhook notifier — posts the raw notification payload as JSON to a
 * caller-supplied URL. This is the extensibility hook: point it at your own
 * incident tooling, a serverless function, PagerDuty's events API, etc.
 */
import type { NotificationMessage, Notifier } from '@driftwatch/sdk';
import { postJson } from './http.js';

export class WebhookNotifier implements Notifier {
  readonly channel = 'webhook';

  constructor(private readonly webhookUrl: string) {}

  async notify(message: NotificationMessage): Promise<void> {
    await postJson(this.webhookUrl, {
      source: 'driftwatch-autopilot',
      ...message,
    });
  }
}
