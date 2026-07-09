/**
 * Provider-agnostic model resolution.
 *
 * The whole point: anyone can run this with whatever provider they have keys
 * for, by setting two env vars — no code changes.
 *
 *   AI_PROVIDER=openai      MODEL=gpt-5.2            OPENAI_API_KEY=...
 *   AI_PROVIDER=anthropic   MODEL=claude-opus-4-6   ANTHROPIC_API_KEY=...
 *   AI_PROVIDER=google      MODEL=gemini-3-flash    GOOGLE_GENERATIVE_AI_API_KEY=...
 *   AI_PROVIDER=gateway     MODEL=anthropic/claude-opus-4.8   AI_GATEWAY_API_KEY=...
 *
 * The `gateway` option is the most turnkey: one key, any model, and you don't
 * even need the provider packages installed — the model is just a string.
 *
 * To keep install size down for people who only use one provider, the provider
 * packages are imported dynamically and only loaded on demand.
 */
import type { LanguageModel } from 'ai';

export type ProviderName = 'gateway' | 'openai' | 'anthropic' | 'google';

const DEFAULTS: Record<ProviderName, string> = {
  gateway: 'anthropic/claude-opus-4.8',
  openai: 'gpt-5.2',
  anthropic: 'claude-opus-4-6',
  google: 'gemini-3-flash',
};

/**
 * Returns a LanguageModel the AI SDK's generateText/streamText can use.
 * Reads AI_PROVIDER + MODEL from env, with sensible fallbacks.
 */
export async function resolveModel(): Promise<{
  model: LanguageModel;
  provider: ProviderName;
  modelId: string;
}> {
  const provider = (process.env.AI_PROVIDER ?? 'gateway') as ProviderName;
  const modelId = process.env.MODEL ?? DEFAULTS[provider];

  switch (provider) {
    case 'gateway': {
      // No provider package needed — a bare string routes through AI Gateway.
      // (Requires AI_GATEWAY_API_KEY, or runs on Vercel with OIDC.)
      return { model: modelId as unknown as LanguageModel, provider, modelId };
    }
    case 'openai': {
      const { openai } = await import('@ai-sdk/openai');
      return { model: openai(modelId), provider, modelId };
    }
    case 'anthropic': {
      const { anthropic } = await import('@ai-sdk/anthropic');
      return { model: anthropic(modelId), provider, modelId };
    }
    case 'google': {
      const { google } = await import('@ai-sdk/google');
      return { model: google(modelId), provider, modelId };
    }
    default:
      throw new Error(
        `Unknown AI_PROVIDER "${provider}". Use: gateway | openai | anthropic | google`,
      );
  }
}
