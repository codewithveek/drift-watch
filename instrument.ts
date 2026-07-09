/**
 * Custom span + metric helpers for the parts the AI SDK's built-in telemetry
 * doesn't cover: labelled tool-call counts and per-tool latency.
 *
 * The AI SDK (experimental_telemetry) already emits spans for LLM steps and
 * tool calls. What it does NOT give you is a metric like "calls per tool, split
 * by ok/error" — which is exactly the reply-thread's "how often does xyz tool
 * get called". So we keep withToolSpan to emit that.
 */
import { trace, metrics, SpanStatusCode, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('agent-drift-watch');
const meter = metrics.getMeter('agent-drift-watch');

// "how often does xyz tool get called"
const toolCallCounter = meter.createCounter('agent.tool.calls', {
  description: 'Count of tool invocations, labelled by tool name + outcome',
});
// latency distribution per tool
const toolLatency = meter.createHistogram('agent.tool.duration', {
  description: 'Tool execution time in ms',
  unit: 'ms',
});

/** Wrap a tool call. Every invocation -> one span + counter increment. */
export async function withToolSpan<T>(
  toolName: string,
  input: unknown,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const start = performance.now();
  return tracer.startActiveSpan(`tool.${toolName}`, async (span) => {
    span.setAttribute('agent.tool.name', toolName);
    span.setAttribute('agent.tool.input', JSON.stringify(input).slice(0, 512));
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      toolCallCounter.add(1, { tool: toolName, outcome: 'ok' });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      toolCallCounter.add(1, { tool: toolName, outcome: 'error' });
      throw err;
    } finally {
      const ms = performance.now() - start;
      toolLatency.record(ms, { tool: toolName });
      span.setAttribute('agent.tool.duration_ms', ms);
      span.end();
    }
  });
}
