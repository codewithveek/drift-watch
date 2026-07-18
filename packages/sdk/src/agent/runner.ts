/**
 * Agent task runner — provider- and tool-agnostic: the caller injects an
 * already configured `ModelClient` (see ../model-client.ts) and its own
 * `tools` (AI SDK `tool()` definitions) rather than this module owning
 * either. `maxSteps` is likewise a parameter, not an env read — thread it
 * through from your own typed config (e.g. `AgentConfig.maxSteps`).
 *
 * generateText + stopWhen runs the full tool-use loop (LLM -> tool -> LLM...)
 * for us. The AI SDK's Telemetry integration (registered by
 * bootstrapTelemetry) emits step spans for every LLM call, so a trace
 * backend shows the whole decision tree without hand-instrumenting each
 * call.
 *
 * Every run gets one parent `agent.run` span carrying the task id, the
 * skills (tools) it used, and its total token spend — so a task's cost is
 * answerable both from the returned AgentTaskResult and from a single trace.
 */
import { randomUUID } from 'node:crypto';
import {
  generateText,
  stepCountIs,
  type LanguageModelUsage,
  type ToolSet,
} from 'ai';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { ModelClient, ModelClientDescriptor } from '../model-client.js';
import { describeModelClient } from '../model-client.js';
import {
  recordUsageOnSpan,
  summarizeTokenUsage,
  type TokenUsageSummary,
} from '../telemetry/usage-tracking.js';
import { isCapturePayloadsEnabled } from '../telemetry/capture-config.js';

const tracer = trace.getTracer('agentpulse');
const DEFAULT_MAXIMUM_AGENT_STEPS = 8;

export interface RunAgentTaskOptions {
  prompt: string;
  modelClient: ModelClient;
  tools: ToolSet;
  /** Defaults to 8 when omitted. Thread this from AgentConfig.maxSteps. */
  maxSteps?: number;
}

export interface AgentTaskResult {
  taskId: string;
  responseText: string;
  stepCount: number;
  skillsUsed: string[];
  tokenUsage: TokenUsageSummary;
  providerName: string;
  modelIdentifier: string;
}

export async function runAgentTask(
  options: RunAgentTaskOptions,
): Promise<AgentTaskResult> {
  const {
    prompt,
    modelClient,
    tools,
    maxSteps = DEFAULT_MAXIMUM_AGENT_STEPS,
  } = options;
  const taskId = randomUUID();
  const modelClientDescriptor = describeModelClient(modelClient);

  return tracer.startActiveSpan('agent.run', async (rootSpan) => {
    rootSpan.setAttribute('agent.task_id', taskId);
    if (isCapturePayloadsEnabled()) {
      rootSpan.setAttribute('agent.prompt', prompt.slice(0, 512));
    }

    try {
      const generateTextResult = await generateText({
        model: modelClient,
        tools,
        stopWhen: stepCountIs(maxSteps),
        prompt,
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'agent-run',
        },
      });

      const toolNamesCalled = generateTextResult.toolCalls.map(
        (toolCall) => toolCall.toolName,
      );

      const agentTaskResult = buildAgentTaskResult({
        taskId,
        responseText: generateTextResult.text,
        stepCount: generateTextResult.steps.length,
        toolNamesCalled,
        tokenUsage: generateTextResult.usage,
        modelClientDescriptor,
      });

      recordAgentTaskOnSpan({ span: rootSpan, agentTaskResult });
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      return agentTaskResult;
    } catch (error) {
      rootSpan.recordException(error as Error);
      rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: String(error),
      });
      throw error;
    } finally {
      rootSpan.end();
    }
  });
}

function buildAgentTaskResult(options: {
  taskId: string;
  responseText: string;
  stepCount: number;
  toolNamesCalled: string[];
  tokenUsage: LanguageModelUsage;
  modelClientDescriptor: ModelClientDescriptor;
}): AgentTaskResult {
  const {
    taskId,
    responseText,
    stepCount,
    toolNamesCalled,
    tokenUsage,
    modelClientDescriptor,
  } = options;
  return {
    taskId,
    responseText,
    stepCount,
    skillsUsed: deduplicateToolNames(toolNamesCalled),
    tokenUsage: summarizeTokenUsage(tokenUsage),
    providerName: modelClientDescriptor.providerName,
    modelIdentifier: modelClientDescriptor.modelIdentifier,
  };
}

function deduplicateToolNames(toolNames: string[]): string[] {
  return Array.from(new Set(toolNames));
}

function recordAgentTaskOnSpan(options: {
  span: Span;
  agentTaskResult: AgentTaskResult;
}): void {
  const { span, agentTaskResult } = options;
  span.setAttribute('agent.steps', agentTaskResult.stepCount);
  span.setAttribute('agent.skills_used', agentTaskResult.skillsUsed.join(','));
  recordUsageOnSpan({
    span,
    modelClientDescriptor: {
      providerName: agentTaskResult.providerName,
      modelIdentifier: agentTaskResult.modelIdentifier,
    },
    tokenUsageSummary: agentTaskResult.tokenUsage,
  });
}
