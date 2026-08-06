/**
 * A `ModelClient` is a pre-configured AI SDK language model, constructed by
 * the caller using whichever provider package they chose to install
 * (`@ai-sdk/anthropic`, `@ai-sdk/openai`, a self-hosted Ollama endpoint, ...).
 *
 * This SDK never imports a provider package itself and never chooses a
 * provider based on an environment variable — it only accepts a ModelClient
 * that has already been constructed elsewhere and passed in. This keeps the
 * SDK's own dependency footprint at zero provider SDKs: a consumer installs
 * only the one package their chosen provider needs, constructs a model with
 * it, and hands it to the SDK's functions.
 */
import type { LanguageModel } from 'ai';

export type ModelClient = LanguageModel;

export interface ModelClientDescriptor {
  providerName: string;
  modelIdentifier: string;
}

/**
 * Every AI SDK provider model object exposes readonly `provider` and
 * `modelId` fields per the LanguageModelV2 spec, so we can read them straight
 * off the injected client instead of tracking provider identity ourselves.
 * The gateway-shorthand string form has no such fields, so it's reported
 * under the "gateway" provider using the string itself as the model id.
 */
export function describeModelClient(
  modelClient: ModelClient,
): ModelClientDescriptor {
  if (typeof modelClient === 'string') {
    return { providerName: 'gateway', modelIdentifier: modelClient };
  }
  return {
    providerName: modelClient.provider,
    modelIdentifier: modelClient.modelId,
  };
}

/**
 * Fails loudly and immediately if no model client was configured, rather
 * than letting the first request fall over with an opaque provider error.
 */
export function assertModelClientIsConfigured(
  modelClient: ModelClient | undefined | null,
): asserts modelClient is ModelClient {
  if (modelClient === undefined || modelClient === null) {
    throw new Error(
      'No model client configured. This SDK does not select a provider ' +
        'for you — construct a LanguageModel with your chosen AI SDK ' +
        'provider package and pass it in as modelClient.',
    );
  }
}
