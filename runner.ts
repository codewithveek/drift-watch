/**
 * Agent runner — now provider-agnostic via the AI SDK.
 *
 * generateText + stopWhen runs the full tool-use loop (LLM -> tool -> LLM ...)
 * for us. experimental_telemetry.isEnabled emits OTel spans for every step and
 * tool call automatically, so SigNoz's trace view shows the whole decision tree
 * without us hand-instrumenting each LLM call.
 *
 * We keep one parent `agent.run` span so the trace has a clean root and we can
 * record the prompt + total step count.
 */
import { generateText, stepCountIs } from 'ai';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { resolveModel } from './model.js';
import { tools } from './tools.js';

const tracer = trace.getTracer('agent-drift-watch');

export async function runAgent(userPrompt: string): Promise<string> {
  return tracer.startActiveSpan('agent.run', async (rootSpan) => {
    rootSpan.setAttribute('agent.prompt', userPrompt.slice(0, 512));
    try {
      const { model, provider, modelId } = await resolveModel();
      rootSpan.setAttribute('gen_ai.request.model', modelId);
      rootSpan.setAttribute('gen_ai.provider', provider);

      const result = await generateText({
        model,
        tools,
        // turn the single call into an agent loop, capped at 8 steps
        stopWhen: stepCountIs(8),
        prompt: userPrompt,
        // AI SDK -> OTel: emit spans for each step + tool call
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'agent-run',
        },
      });

      rootSpan.setAttribute('agent.steps', result.steps.length);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      return result.text;
    } catch (err) {
      rootSpan.recordException(err as Error);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      rootSpan.end();
    }
  });
}
