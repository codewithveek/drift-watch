/**
 * Shared shape for "what did this LLM call cost, and with what" — surfaced
 * both in span attributes (for trace correlation) and directly in
 * `AgentTaskResult` (so token spend and provider/model are visible without
 * opening a tracing backend at all). Also owns the `agent.tokens` metric
 * counter (moved here from telemetry/ai-sdk-otel.ts — that module's shared,
 * stateless Telemetry integration has no visibility into which agent is
 * running a given task, only the AI SDK's own per-step event payload, so it
 * can't label the counter by agent; runner.ts/detector.ts call
 * recordTokenUsageMetric directly instead, once they have the final usage
 * and (optionally) an agentId in scope).
 */
import type { LanguageModelUsage } from 'ai';
import { metrics, type Counter, type Span } from '@opentelemetry/api';
import type { ModelClientDescriptor } from '../model-client.js';
import { buildAgentLabels } from './agent-labels.js';

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

/**
 * Lazily created — see instrument.ts for why module-load creation binds to a
 * no-op meter. Meter name matches instrument.ts's/actions.ts's ('driftwatch')
 * rather than the old split-off 'driftwatch.ai-sdk' this counter used when it
 * lived in the AI-SDK bridge file — that split was an accident of where the
 * counter happened to be created, not a deliberate choice.
 */
let cachedTokenUsageCounter: Counter | undefined;
function getTokenUsageCounter(): Counter {
  if (!cachedTokenUsageCounter) {
    cachedTokenUsageCounter = metrics
      .getMeter('driftwatch')
      .createCounter('agent.tokens', {
        description: 'Token usage per model/provider/task, split by input/output',
      });
  }
  return cachedTokenUsageCounter;
}

/**
 * Records the low-cardinality counterpart to recordUsageOnSpan: model,
 * provider, functionId (a bounded set — 'agent-run', 'drift-judge'), and
 * optionally which agent (see buildAgentLabels) — so aggregate token spend
 * stays queryable, filterable per agent, without unbounded per-request
 * cardinality (no task id here; that lives on the span only).
 */
export function recordTokenUsageMetric(options: {
  usage: TokenUsageSummary;
  providerName: string;
  modelIdentifier: string;
  functionId: string;
  agentId?: string;
  serviceName?: string;
}): void {
  const { usage, providerName, modelIdentifier, functionId, agentId, serviceName } = options;
  const counter = getTokenUsageCounter();
  const labels = {
    model: modelIdentifier,
    provider: providerName,
    function_id: functionId,
    ...buildAgentLabels(agentId, serviceName),
  };
  if (usage.inputTokens > 0) counter.add(usage.inputTokens, { ...labels, type: 'input' });
  if (usage.outputTokens > 0) counter.add(usage.outputTokens, { ...labels, type: 'output' });
}
