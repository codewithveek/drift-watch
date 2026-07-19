/**
 * Bring your own model client — the ONE place a deployment wires up a
 * provider. Edit this file; nothing else needs to change.
 *
 * This deployment targets **Qwen Cloud**, which exposes an OpenAI-compatible
 * endpoint, so we use the AI SDK's `createOpenAI` factory pointed at the Qwen
 * base URL. Both `runAgentTask` (the agent) and `detectBehavioralDrift` (the
 * drift judge) use the `modelClient` exported here — nowhere else in the
 * codebase picks a provider.
 *
 * Credentials come from `.env` (never hardcode them):
 *
 *   QWEN_BASE_URL   OpenAI-compatible base URL for Qwen Cloud, e.g.
 *                   https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 *   QWEN_API_KEY    your Qwen Cloud API key
 *   MODEL           model id, e.g. qwen3.7-max / qwen-plus / qwen-turbo
 *
 * To target a different provider instead, install exactly the one package you
 * need and swap the factory below. For example, Anthropic:
 *
 *   pnpm --filter @driftwatch/server add @ai-sdk/anthropic
 *   import { anthropic } from '@ai-sdk/anthropic';
 *   export const modelClient: ModelClient = anthropic(
 *     process.env.MODEL ?? 'claude-3-5-sonnet-latest',
 *   );
 *
 * This file reads QWEN_* / MODEL directly from process.env rather than through
 * the typed config schemas used elsewhere — it's the one deliberate exception,
 * since the whole point of this file is that you hand-edit it per deployment.
 * Everything downstream (runAgentTask, detectBehavioralDrift) takes the
 * resulting modelClient as a plain typed value, not an env lookup.
 *
 * The server refuses to start without a modelClient — there is no implicit
 * fallback beyond what you configure here.
 */
import { createOpenAI } from '@ai-sdk/openai';
import type { ModelClient } from '@driftwatch/sdk';

const qwenCloud = createOpenAI({
  baseURL:
    process.env.QWEN_BASE_URL ??
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.QWEN_API_KEY ?? '',
});

export const modelClient: ModelClient = qwenCloud(
  process.env.MODEL ?? 'qwen3.7-max',
);
