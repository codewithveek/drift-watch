/**
 * Custom span + metric helpers for the parts the AI SDK's built-in telemetry
 * doesn't cover: labelled tool-call counts and per-tool latency.
 *
 * The AI SDK (experimental_telemetry) already emits spans for LLM steps and
 * tool calls. What it does NOT give you is a metric like "calls per tool,
 * split by ok/error" — so withSkillExecutionSpan emits that. A "skill" here
 * is the same thing as an AI SDK `tool()` definition; we use the more
 * product-facing term in span/metric naming.
 */
import { trace, metrics, SpanStatusCode, type Span } from '@opentelemetry/api';
import { isCapturePayloadsEnabled } from './capture-config.js';

const tracer = trace.getTracer('driftwatch');
const meter = metrics.getMeter('driftwatch');

const skillInvocationCounter = meter.createCounter('agent.tool.calls', {
  description: 'Count of skill (tool) invocations, labelled by name + outcome',
});
const skillExecutionDurationHistogram = meter.createHistogram(
  'agent.tool.duration',
  {
    description: 'Skill (tool) execution time in ms',
    unit: 'ms',
  },
);

export interface WithSkillExecutionSpanOptions<SkillResult> {
  skillName: string;
  skillInput: unknown;
  executeSkill: (span: Span) => Promise<SkillResult>;
}

/** Wraps a skill (tool) call. Every invocation -> one span + counter increment. */
export async function withSkillExecutionSpan<SkillResult>(
  options: WithSkillExecutionSpanOptions<SkillResult>,
): Promise<SkillResult> {
  const { skillName, skillInput, executeSkill } = options;
  const executionStartTimeMs = performance.now();

  return tracer.startActiveSpan(`tool.${skillName}`, async (span) => {
    span.setAttribute('agent.tool.name', skillName);
    if (isCapturePayloadsEnabled()) {
      span.setAttribute(
        'agent.tool.input',
        JSON.stringify(skillInput).slice(0, 512),
      );
    }
    try {
      const skillResult = await executeSkill(span);
      span.setStatus({ code: SpanStatusCode.OK });
      skillInvocationCounter.add(1, { tool: skillName, outcome: 'ok' });
      return skillResult;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      skillInvocationCounter.add(1, { tool: skillName, outcome: 'error' });
      throw error;
    } finally {
      const executionDurationMs = performance.now() - executionStartTimeMs;
      skillExecutionDurationHistogram.record(executionDurationMs, {
        tool: skillName,
      });
      span.setAttribute('agent.tool.duration_ms', executionDurationMs);
      span.end();
    }
  });
}
