/**
 * AI SDK v7 -> OTel bridge.
 *
 * v7 replaced the auto-emitted `experimental_telemetry` spans with an explicit
 * `Telemetry` integration interface. Without an integration registered,
 * setting `isEnabled: true` on a call is inert — no LLM/step spans. This
 * bridge implements the integration once and forwards per-step tracing into
 * OTel: one `gen_ai.step` span per LLM step (model, tokens, finish reason).
 *
 * Token *metrics* (the `agent.tokens` counter) are NOT emitted here — they
 * live in usage-tracking.ts's `recordTokenUsageMetric`, called directly by
 * runner.ts/detector.ts once they have the final usage AND an `agentId` in
 * scope. This class is a shared, stateless singleton registered once
 * globally by bootstrapTelemetry(); it only ever sees the AI SDK's own
 * per-step event payload, with no visibility into which agent a given task
 * belongs to — so it structurally can't label a per-agent counter correctly,
 * and shouldn't try.
 *
 * Registered automatically by bootstrapTelemetry(); exported for consumers
 * who want to wire telemetry up manually instead.
 */
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { Telemetry } from 'ai';

const tracer = trace.getTracer('driftwatch.ai-sdk');

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

  onStepEnd = (stepEndEvent: ModelStepEvent): void => {
    const stepSpan = this.activeStepSpans.get(stepEndEvent);
    if (!stepSpan) return;
    applyModelStepAttributes(stepSpan, stepEndEvent);
    stepSpan.setStatus({ code: SpanStatusCode.OK });
    stepSpan.end();
    this.activeStepSpans.delete(stepEndEvent);
  };
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
