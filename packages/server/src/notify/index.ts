/**
 * Notifier registry — builds the configured notifiers from ServerConfig.
 * The concrete channels (Slack/Telegram/webhook) come from
 * @driftwatch/autopilot; the registry type and dispatch helpers
 * (notifierForAction, safeNotify, notifyAll) come from @driftwatch/sdk, since
 * they're pure orchestration over the Notifier interface, not this server's
 * concern.
 */
import type { NotifierRegistry } from '@driftwatch/sdk';
import { SlackNotifier, TelegramNotifier, WebhookNotifier } from '@driftwatch/autopilot';
import type { ServerConfig } from '../config/server-config.js';

export {
  notifierForAction,
  safeNotify,
  notifyAll,
  type NotifierRegistry,
  type DispatchLogger,
} from '@driftwatch/sdk';

export function createNotifiers(config: ServerConfig): NotifierRegistry {
  const registry: NotifierRegistry = { list: [] };

  if (config.slackWebhookUrl) {
    registry.slack = new SlackNotifier(config.slackWebhookUrl);
    registry.list.push(registry.slack);
  }
  if (config.telegramBotToken && config.telegramChatId) {
    registry.telegram = new TelegramNotifier(
      config.telegramBotToken,
      config.telegramChatId,
    );
    registry.list.push(registry.telegram);
  }
  if (config.webhookUrl) {
    registry.webhook = new WebhookNotifier(config.webhookUrl);
    registry.list.push(registry.webhook);
  }

  return registry;
}
