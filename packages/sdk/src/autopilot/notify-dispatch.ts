/**
 * Notifier registry + fire-and-forget dispatch. Pure orchestration over the
 * `Notifier` interface — no concrete channel (Slack/Telegram/webhook) lives
 * here. Concrete notifiers are in the companion `@driftwatch/autopilot`
 * package (or bring your own — anything implementing `Notifier`).
 *
 * Dispatch never throws into the caller: a channel failure is logged and
 * swallowed so one broken webhook can't stall the drift loop.
 */
import type { ActionType, NotificationMessage, Notifier } from './types.js';

export interface NotifierRegistry {
  slack?: Notifier;
  telegram?: Notifier;
  webhook?: Notifier;
  /** All configured notifiers, in a stable order. */
  list: Notifier[];
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
