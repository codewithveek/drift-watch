/**
 * AI SDK v7 -> OTel bridge.
 *
 * v7 replaced the auto-emitted `experimental_telemetry` spans with an explicit
 * `Telemetry` integration interface. Without an integration registered,
 * setting `isEnabled: true` on a call is inert — no LLM/step spans, no token
 * counts. This bridge implements the integration once and forwards the
 * events we care about into OTel: one span per LLM step (model, tokens,
 * finish reason) and one counter per token direction, labelled by model,
 * provider, and functionId (a bounded set — 'agent-run', 'drift-judge' —
 * naming which kind of task the tokens were spent on) so aggregate token
 * spend stays queryable without unbounded per-request cardinality.
 *
 * Registered automatically by bootstrapTelemetry(); exported for consumers
 * who want to wire telemetry up manually instead.
 */
import { trace, metrics, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { Telemetry } from 'ai';

const tracer = trace.getTracer('driftwatch.ai-sdk');
const meter = metrics.getMeter('driftwatch.ai-sdk');

const tokenUsageCounter = meter.createCounter('agent.tokens', {
  description:
    'Token usage per model/provider/task, split by input/output',
});

interface ModelStepEvent {
  functionId?: string;
  model?: { modelId?: string; provider?: string };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  finishReason?: string;
}

interface StepStartEvent {
  stepNumber?: number;
  functionId?: string;
}

/**
 * Minimal Telemetry integration. Emits an OTel span per step with model,
 * provider, and token attributes. Skill (tool) spans are already covered by
 * withSkillExecutionSpan in instrument.ts — we don't emit them here to avoid
 * double-counting.
 */
export class AiSdkOtelIntegration implements Telemetry {
  private readonly activeStepSpans = new WeakMap<object, Span>();

  onStepStart = (stepStartEvent: StepStartEvent): void => {
    const stepSpan = tracer.startSpan('gen_ai.step', {
      attributes: {
        'gen_ai.step.number': stepStartEvent.stepNumber ?? 0,
        'gen_ai.function_id': stepStartEvent.functionId ?? 'unknown',
      },
    });
    this.activeStepSpans.set(stepStartEvent, stepSpan);
  };

  onLanguageModelCallEnd = (
    languageModelCallEndEvent: ModelStepEvent,
  ): void => {
    recordTokenUsage(languageModelCallEndEvent, tokenUsageCounter);
  };

  onStepEnd = (stepEndEvent: ModelStepEvent): void => {
    const stepSpan = this.activeStepSpans.get(stepEndEvent);
    if (!stepSpan) return;
    applyModelStepAttributes(stepSpan, stepEndEvent);
    stepSpan.setStatus({ code: SpanStatusCode.OK });
    stepSpan.end();
    this.activeStepSpans.delete(stepEndEvent);
  };
}

function recordTokenUsage(
  modelStepEvent: ModelStepEvent,
  counter: ReturnType<typeof meter.createCounter>,
): void {
  const modelIdentifier = modelStepEvent.model?.modelId ?? 'unknown';
  const providerName = modelStepEvent.model?.provider ?? 'unknown';
  const taskFunctionId = modelStepEvent.functionId ?? 'unknown';
  const inputTokenCount = modelStepEvent.usage?.inputTokens ?? 0;
  const outputTokenCount = modelStepEvent.usage?.outputTokens ?? 0;

  const labels = {
    model: modelIdentifier,
    provider: providerName,
    function_id: taskFunctionId,
  };
  if (inputTokenCount > 0) {
    counter.add(inputTokenCount, { ...labels, type: 'input' });
  }
  if (outputTokenCount > 0) {
    counter.add(outputTokenCount, { ...labels, type: 'output' });
  }
}

function applyModelStepAttributes(
  stepSpan: Span,
  modelStepEvent: ModelStepEvent,
): void {
  if (modelStepEvent.model?.modelId) {
    stepSpan.setAttribute('gen_ai.request.model', modelStepEvent.model.modelId);
  }
  if (modelStepEvent.model?.provider) {
    stepSpan.setAttribute('gen_ai.provider', modelStepEvent.model.provider);
  }
  if (modelStepEvent.usage?.inputTokens !== undefined) {
    stepSpan.setAttribute(
      'gen_ai.usage.input_tokens',
      modelStepEvent.usage.inputTokens,
    );
  }
  if (modelStepEvent.usage?.outputTokens !== undefined) {
    stepSpan.setAttribute(
      'gen_ai.usage.output_tokens',
      modelStepEvent.usage.outputTokens,
    );
  }
  if (modelStepEvent.finishReason) {
    stepSpan.setAttribute(
      'gen_ai.response.finish_reason',
      modelStepEvent.finishReason,
    );
  }
}
