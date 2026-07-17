/**
 * Bring your own model client — the ONE place a deployment wires up a
 * provider. Edit this file; nothing else needs to change.
 *
 * @agentpulse/sdk ships with zero AI provider SDKs installed. The default
 * below uses the Vercel AI Gateway, which is bundled inside the `ai` package
 * itself, so it works with no extra installs — just AI_GATEWAY_API_KEY (or
 * Vercel OIDC when deployed on Vercel).
 *
 * To call a provider directly instead, install exactly the one package you
 * need and swap the two lines below. For example, Anthropic:
 *
 *   pnpm --filter @agentpulse/server add @ai-sdk/anthropic
 *
 *   import { anthropic } from '@ai-sdk/anthropic';
 *   export const modelClient: ModelClient = anthropic(
 *     process.env.MODEL ?? 'claude-3-5-sonnet-latest',
 *   );
 *
 * Same pattern for @ai-sdk/openai or @ai-sdk/google. For any OpenAI-compatible
 * endpoint (Ollama, vLLM, Together, Groq, DeepSeek, ...):
 *
 *   pnpm --filter @agentpulse/server add @ai-sdk/openai
 *
 *   import { createOpenAI } from '@ai-sdk/openai';
 *   const openaiCompatibleClient = createOpenAI({
 *     baseURL: process.env.OPENAI_BASE_URL, // e.g. http://localhost:11434/v1
 *     apiKey: process.env.OPENAI_API_KEY ?? 'not-used',
 *   });
 *   export const modelClient: ModelClient = openaiCompatibleClient(
 *     process.env.MODEL ?? 'llama3.1',
 *   );
 *
 * This file reads MODEL directly from process.env rather than through the
 * typed config schemas used elsewhere — it's the one deliberate exception,
 * since the whole point of this file is that you hand-edit it per
 * deployment. Everything downstream of it (runAgentTask, detectBehavioralDrift)
 * takes the resulting modelClient as a plain typed value, not an env lookup.
 *
 * The server refuses to start without a modelClient — there is no implicit
 * fallback beyond what you configure here.
 */
import { gateway } from 'ai';
import type { ModelClient } from '@agentpulse/sdk';

export const modelClient: ModelClient = gateway(
  process.env.MODEL ?? 'anthropic/claude-3-5-sonnet',
);
