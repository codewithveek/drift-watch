/**
 * Notifier registry + fire-and-forget dispatch.
 *
 * Builds the configured notifiers from ServerConfig and provides helpers to
 * (a) send a plain notification to one channel (for notify_* actions) and
 * (b) broadcast an approval request to every channel (so a control action can
 * be approved from Slack, Telegram, or the console — including on mobile).
 *
 * Dispatch never throws into the caller: a channel failure is logged and
 * swallowed so one broken webhook can't stall the drift loop.
 */
import type {
  ActionType,
  NotificationMessage,
  Notifier,
} from '@driftwatch/sdk';
import type { ServerConfig } from '../config/server-config.js';
import { SlackNotifier } from './slack.js';
import { TelegramNotifier } from './telegram.js';
import { WebhookNotifier } from './webhook.js';

export interface NotifierRegistry {
  slack?: Notifier;
  telegram?: Notifier;
  webhook?: Notifier;
  /** All configured notifiers, in a stable order. */
  list: Notifier[];
}

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

/** Map a notify_* action to its concrete channel notifier, if configured. */
export function notifierForAction(
  registry: NotifierRegistry,
  action: ActionType,
): Notifier | undefined {
  switch (action) {
    case 'notify_slack':
      return registry.slack;
    case 'notify_telegram':
      return registry.telegram;
    case 'notify_webhook':
      return registry.webhook;
    default:
      return undefined;
  }
}

export interface DispatchLogger {
  error: (obj: unknown, msg?: string) => void;
}

/** Fire-and-forget send to a single notifier; failures are logged, not thrown. */
export async function safeNotify(
  notifier: Notifier,
  message: NotificationMessage,
  logger?: DispatchLogger,
): Promise<void> {
  try {
    await notifier.notify(message);
  } catch (error) {
    logger?.error({ error, channel: notifier.channel }, 'notification failed');
  }
}

/** Broadcast a message to every configured notifier concurrently. */
export async function notifyAll(
  registry: NotifierRegistry,
  message: NotificationMessage,
  logger?: DispatchLogger,
): Promise<void> {
  await Promise.all(
    registry.list.map((notifier) => safeNotify(notifier, message, logger)),
  );
}
