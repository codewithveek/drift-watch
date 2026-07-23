/**
 * Bring your own model client(s) — the ONE place a deployment wires up a
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
 *   QWEN_BASE_URL    OpenAI-compatible base URL for Qwen Cloud, e.g.
 *                    https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 *   QWEN_API_KEY     your Qwen Cloud API key
 *   MODEL            primary model id, e.g. qwen3.7-max
 *   MODEL_FALLBACK   optional cheaper model id Autopilot can switch the agent
 *                    to when a policy fires `switch_model` (e.g. qwen-plus).
 *
 * ## Model registry (Autopilot model switching)
 *
 * `modelRegistry` maps a model id -> a constructed client. The reference
 * server routes each `/run` to `modelRegistry[activeModel]` when Autopilot has
 * switched the agent (see routes/agent.ts), falling back to `modelClient`
 * (the primary) otherwise. Add entries here to give Autopilot more models to
 * choose between; the id you switch to is set by AUTOPILOT_SWITCH_MODEL_TO
 * (defaults to MODEL_FALLBACK). The drift judge always uses the primary
 * `modelClient`, so switching the agent's model never weakens the judge.
 *
 * To target a different provider entirely, install exactly the one package you
 * need and swap the factory below (e.g. `import { anthropic } from
 * '@ai-sdk/anthropic'`). Everything downstream takes the resulting
 * ModelClient(s) as plain typed values, not env lookups.
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

/** Primary model id — the agent's default and the drift judge's model. */
export const defaultModelId = process.env.MODEL ?? 'qwen3.7-max';

/** Optional cheaper/fallback model id Autopilot can switch the agent to. */
const fallbackModelId = process.env.MODEL_FALLBACK ?? '';

/**
 * Models the agent can be routed to, keyed by the id `switch_model` /
 * AUTOPILOT_SWITCH_MODEL_TO reference. Ships with the primary and, if set, the
 * fallback — add more entries to expand Autopilot's choices.
 */
export const modelRegistry: Record<string, ModelClient> = {
  [defaultModelId]: qwenCloud(defaultModelId),
};
if (fallbackModelId && fallbackModelId !== defaultModelId) {
  modelRegistry[fallbackModelId] = qwenCloud(fallbackModelId);
}

/** Primary client — used by the drift judge and as the agent's default. */
export const modelClient: ModelClient = modelRegistry[defaultModelId];
