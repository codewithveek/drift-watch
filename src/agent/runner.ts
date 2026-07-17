/**
 * Agent task runner — provider-agnostic: the caller injects an already
 * configured `ModelClient` (see agent/model-client.ts) rather than this
 * module choosing a provider itself.
 *
 * generateText + stopWhen runs the full tool-use loop (LLM -> tool -> LLM...)
 * for us. The AI SDK's Telemetry integration (registered in telemetry/otel.ts)
 * emits step spans for every LLM call, so SigNoz's trace view shows the whole
 * decision tree without us hand-instrumenting each call.
 *
 * Every run gets one parent `agent.run` span carrying the task id, the
 * skills (tools) it used, and its total token spend — so a task's cost is
 * answerable both from the API response and from a single trace in SigNoz.
 */
import { randomUUID } from 'node:crypto';
import { generateText, stepCountIs, type LanguageModelUsage } from 'ai';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { ModelClient, ModelClientDescriptor } from './model-client.js';
import { describeModelClient } from './model-client.js';
import { tools } from './tools.js';
import {
  recordUsageOnSpan,
  summarizeTokenUsage,
  type TokenUsageSummary,
} from '../telemetry/usage-tracking.js';

const tracer = trace.getTracer('agentpulse');
const MAXIMUM_AGENT_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 8);

export interface RunAgentTaskOptions {
  prompt: string;
  modelClient: ModelClient;
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
  const { prompt, modelClient } = options;
  const taskId = randomUUID();
  const modelClientDescriptor = describeModelClient(modelClient);

  return tracer.startActiveSpan('agent.run', async (rootSpan) => {
    rootSpan.setAttribute('agent.task_id', taskId);
    rootSpan.setAttribute('agent.prompt', prompt.slice(0, 512));

    try {
      const generateTextResult = await generateText({
        model: modelClient,
        tools,
        stopWhen: stepCountIs(MAXIMUM_AGENT_STEPS),
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
