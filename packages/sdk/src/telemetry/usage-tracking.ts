/**
 * Shared shape for "what did this LLM call cost, and with what" — surfaced
 * both in span attributes (for trace correlation) and directly in
 * `AgentTaskResult` (so token spend and provider/model are visible without
 * opening a tracing backend at all).
 */
import type { LanguageModelUsage } from 'ai';
import type { Span } from '@opentelemetry/api';
import type { ModelClientDescriptor } from '../model-client.js';

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function summarizeTokenUsage(
  usage: LanguageModelUsage,
): TokenUsageSummary {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

/**
 * Attaches provider/model identity and token usage to a span as attributes
 * rather than as metric labels. Metric labels must stay low-cardinality
 * (tool name, outcome, provider, model); a per-task or per-request id would
 * blow up cardinality on a counter. Span attributes have no such limit — an
 * operator can search traces by task id and see exactly which model call
 * and how many tokens a given task cost.
 */
export function recordUsageOnSpan(options: {
  span: Span;
  modelClientDescriptor: ModelClientDescriptor;
  tokenUsageSummary: TokenUsageSummary;
}): void {
  const { span, modelClientDescriptor, tokenUsageSummary } = options;
  span.setAttribute('gen_ai.provider', modelClientDescriptor.providerName);
  span.setAttribute(
    'gen_ai.request.model',
    modelClientDescriptor.modelIdentifier,
  );
  span.setAttribute(
    'gen_ai.usage.input_tokens',
    tokenUsageSummary.inputTokens,
  );
  span.setAttribute(
    'gen_ai.usage.output_tokens',
    tokenUsageSummary.outputTokens,
  );
  span.setAttribute(
    'gen_ai.usage.total_tokens',
    tokenUsageSummary.totalTokens,
  );
}
