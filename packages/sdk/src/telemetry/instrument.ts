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
import {
  trace,
  metrics,
  SpanStatusCode,
  type Counter,
  type Histogram,
  type Span,
} from '@opentelemetry/api';
import { isCapturePayloadsEnabled } from './capture-config.js';
import { buildAgentLabels } from './agent-labels.js';

const tracer = trace.getTracer('driftwatch');

/**
 * Metric instruments are created lazily, NOT at module load. This module is
 * pulled in (via the package barrel) by telemetry-bootstrap before
 * `bootstrapTelemetry()` runs `sdk.start()`, i.e. before the global
 * MeterProvider is registered. Unlike the Trace API — whose `getTracer` hands
 * back a ProxyTracer that upgrades once the real provider is set — the Metrics
 * API returns a permanent NoopMeter when no provider is registered yet, and
 * instruments made from it silently drop every measurement forever. Creating
 * them on first record() (during a request, long after start) binds them to
 * the real MeterProvider so `agent.tool.*` actually reaches the backend.
 */
let cachedInstruments:
  | { calls: Counter; duration: Histogram }
  | undefined;
function getSkillInstruments(): { calls: Counter; duration: Histogram } {
  if (!cachedInstruments) {
    const meter = metrics.getMeter('driftwatch');
    cachedInstruments = {
      calls: meter.createCounter('agent.tool.calls', {
        description:
          'Count of skill (tool) invocations, labelled by name + outcome',
      }),
      duration: meter.createHistogram('agent.tool.duration', {
        description: 'Skill (tool) execution time in ms',
        unit: 'ms',
      }),
    };
  }
  return cachedInstruments;
}

/** Thrown when a policyGate denies a tool call — see WithSkillExecutionSpanOptions.policyGate. */
export class ToolCallDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ToolCallDeniedError';
  }
}

export interface WithSkillExecutionSpanOptions<SkillResult> {
  skillName: string;
  skillInput: unknown;
  executeSkill: (span: Span) => Promise<SkillResult>;
  /** Attributes the span + counter/histogram to this agent — see buildAgentLabels. */
  agentId?: string;
  /** The agent's OTel service.name, if known — see buildAgentLabels. */
  serviceName?: string;
  /**
   * Pre-execution policy check (Loop 3 — see autopilot/tool-call-gate.ts).
   * Called and fully resolved BEFORE `executionStartTimeMs` is captured and
   * the `tool.${skillName}` span starts — this is deliberate, not
   * incidental: a `require_approval` gate can wait anywhere from seconds to
   * minutes for a human, and `agent.tool.duration` feeds Loop 2's p95-delta
   * drift trigger (see drift/prometheus-source.ts). If approval-wait time
   * leaked into that histogram, a slow human clicking "Approve" would look
   * like a latency spike and could cause Loop 2 to autonomously react to
   * what is actually just approval latency, not real drift. Keep this
   * ordering if you ever touch this function.
   */
  policyGate?: (skillInput: unknown) => Promise<{ allowed: boolean; reason?: string }>;
}

/** Wraps a skill (tool) call. Every invocation -> one span + counter increment. */
export async function withSkillExecutionSpan<SkillResult>(
  options: WithSkillExecutionSpanOptions<SkillResult>,
): Promise<SkillResult> {
  const { skillName, skillInput, executeSkill, agentId, serviceName, policyGate } = options;
  const { calls: skillInvocationCounter, duration: skillExecutionDurationHistogram } =
    getSkillInstruments();
  const agentLabels = buildAgentLabels(agentId, serviceName);

  if (policyGate) {
    const gate = await policyGate(skillInput);
    if (!gate.allowed) {
      const reason = gate.reason ?? `tool call denied by policy: ${skillName}`;
      skillInvocationCounter.add(1, { tool: skillName, outcome: 'denied', ...agentLabels });
      const deniedSpan = tracer.startSpan(`tool.${skillName}`);
      deniedSpan.setAttribute('agent.tool.name', skillName);
      deniedSpan.setAttributes(agentLabels);
      deniedSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      deniedSpan.end();
      throw new ToolCallDeniedError(reason);
    }
  }

  const executionStartTimeMs = performance.now();

  return tracer.startActiveSpan(`tool.${skillName}`, async (span) => {
    span.setAttribute('agent.tool.name', skillName);
    span.setAttributes(agentLabels);
    if (isCapturePayloadsEnabled()) {
      span.setAttribute(
        'agent.tool.input',
        JSON.stringify(skillInput).slice(0, 512),
      );
    }
    try {
      const skillResult = await executeSkill(span);
      span.setStatus({ code: SpanStatusCode.OK });
      skillInvocationCounter.add(1, { tool: skillName, outcome: 'ok', ...agentLabels });
      return skillResult;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      skillInvocationCounter.add(1, { tool: skillName, outcome: 'error', ...agentLabels });
      throw error;
    } finally {
      const executionDurationMs = performance.now() - executionStartTimeMs;
      skillExecutionDurationHistogram.record(executionDurationMs, {
        tool: skillName,
        ...agentLabels,
      });
      span.setAttribute('agent.tool.duration_ms', executionDurationMs);
      span.end();
    }
  });
}
