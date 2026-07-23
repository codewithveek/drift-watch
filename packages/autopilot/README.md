# @driftwatch/autopilot

Slack, Telegram, and generic-webhook notifiers, plus inbound-webhook signature
verification, for [DriftWatch](https://github.com/codewithveek/drift-watch)
Autopilot. A companion to `@driftwatch/sdk` — bring this in only if you use
those channels; the SDK's approval/scheduler orchestration works against any
`Notifier` implementation, including your own.

## Install

```bash
npm install @driftwatch/sdk @driftwatch/autopilot
```

## Notifiers

Each implements the SDK's `Notifier` interface (`notify(message)`), so they
plug straight into `NotifierRegistry` / `ApprovalService` / `AutopilotScheduler`
from `@driftwatch/sdk`:

```ts
import { SlackNotifier, TelegramNotifier, WebhookNotifier } from '@driftwatch/autopilot';
import type { NotifierRegistry } from '@driftwatch/sdk';

const notifiers: NotifierRegistry = {
  slack: new SlackNotifier(process.env.SLACK_WEBHOOK_URL!),
  telegram: new TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN!, process.env.TELEGRAM_CHAT_ID!),
  webhook: new WebhookNotifier(process.env.DRIFT_WEBHOOK_URL!),
  list: [], // populate with whichever of the above you configured
};
```

## Verifying inbound callbacks

Approve/Reject buttons post back to your server. These helpers are
framework-agnostic — read the raw body/headers in your HTTP layer and hand them
over:

```ts
import { verifySlackSignature, parseSlackInteraction } from '@driftwatch/autopilot';

// Fastify example
fastify.post('/integrations/slack/actions', async (request, reply) => {
  const rawBody = request.body as string; // parsed as a raw string, not JSON
  const ok = verifySlackSignature(
    rawBody,
    request.headers['x-slack-request-timestamp'] as string,
    request.headers['x-slack-signature'] as string,
    process.env.SLACK_SIGNING_SECRET!,
  );
  if (!ok) return reply.code(401).send();

  const interaction = parseSlackInteraction(rawBody);
  // interaction.approvalId, interaction.decision, interaction.actor
});
```

```ts
import { verifyTelegramSecretToken, parseTelegramCallback, answerTelegramCallback } from '@driftwatch/autopilot';

fastify.post('/integrations/telegram/webhook', async (request, reply) => {
  const ok = verifyTelegramSecretToken(
    request.headers['x-telegram-bot-api-secret-token'] as string,
    process.env.TELEGRAM_SECRET_TOKEN!,
  );
  if (!ok) return reply.code(401).send();

  const callback = parseTelegramCallback(request.body);
  if (!callback) return reply.send({ ok: true }); // not a button tap
  // callback.approvalId, callback.decision, callback.actor
});
```

Full docs: [drift-watch docs](https://github.com/codewithveek/drift-watch/tree/main/docs).

## License

MIT — see [LICENSE](https://github.com/codewithveek/drift-watch/blob/main/LICENSE).
