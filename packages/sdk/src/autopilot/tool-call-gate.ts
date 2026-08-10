/**
 * Orchestrates one tool call against its agent's resolved tool-call
 * policies (Loop 3): evaluate, and for `require_approval`, create the
 * pending approval, notify, and wait.
 *
 * Deliberately a plain async function, NOT a stateful class like
 * `ApprovalService`. `ApprovalService` arms a `setTimeout` because
 * control-approvals are fire-and-forget from a background scan cycle —
 * nothing is synchronously waiting on them, so something has to proactively
 * expire a forgotten one. Here, the caller (a tool's `execute()`, inside the
 * agent's own request) is ALREADY synchronously awaiting the whole time, so
 * on its own local timeout it can just self-resolve the stored approval and
 * return — no background timer or shutdown lifecycle needed.
 *
 * Also deliberately NOT using the AI SDK's native `needsApproval`/
 * `tool-approval-request` pause-resume mechanism (present in the pinned
 * `ai` package). That mechanism halts `generateText`'s whole step loop and
 * requires resuming with `messages` (not `prompt`) across a second call —
 * adopting it would mean persisting conversation state across HTTP calls and
 * turning `/agents/:agentId/run` into a pause/resume API. Gating inside one
 * tool's `execute()` keeps `runAgentTask`'s single-shot `prompt ->
 * responseText` HTTP contract completely intact.
 *
 * Polling, not pub/sub: there's no blocking-wait primitive anywhere else in
 * this codebase (`RESOLVE_APPROVAL_LUA` is a pure CAS), and pub/sub would
 * need a second dedicated ioredis subscriber connection purely to shave a
 * fraction of a second off a flow that will typically take a human much
 * longer to act on anyway. A future optimization, not a launch requirement.
 */
import { randomUUID } from 'node:crypto';
import type { StateStore, ToolCallApproval } from './types.js';
import type { ToolCallPolicyRule } from './tool-call-policy.js';
import { evaluateToolCallPolicy } from './tool-call-policy.js';
import { notifyAll, type DispatchLogger, type NotifierRegistry } from './notify-dispatch.js';
import { isCapturePayloadsEnabled } from '../telemetry/capture-config.js';

const DEFAULT_POLL_INTERVAL_MS = 500;

export interface GateToolCallOptions {
  tool: string;
  input: unknown;
  agentId: string;
  rules: ToolCallPolicyRule[];
  store: StateStore;
  notifiers: NotifierRegistry;
  approvalTimeoutMs: number;
  timeoutDecision: 'approved' | 'rejected';
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
  logger?: DispatchLogger;
}

export type GateToolCallResult = { allowed: true } | { allowed: false; reason: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function gateToolCall(options: GateToolCallOptions): Promise<GateToolCallResult> {
  const {
    tool,
    input,
    agentId,
    rules,
    store,
    notifiers,
    approvalTimeoutMs,
    timeoutDecision,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    abortSignal,
    logger,
  } = options;

  // Hot path for agents with no configured policies — zero I/O, stay allocation-light.
  if (rules.length === 0) return { allowed: true };

  const verdict = evaluateToolCallPolicy(tool, input, rules);
  if (verdict.action === 'allow') return { allowed: true };
  if (verdict.action === 'deny') {
    return { allowed: false, reason: verdict.matchedRule?.reason ?? `tool call denied by policy: ${tool}` };
  }

  // require_approval
  const now = Date.now();
  const approval: ToolCallApproval = {
    id: randomUUID(),
    agentId,
    tool,
    fieldPath: verdict.matchedRule?.field,
    matchedReason: verdict.matchedRule?.reason,
    // Never leak a sensitive field's actual value into a Slack/Telegram
    // message by default — that would defeat the point of gating it.
    inputSummary: isCapturePayloadsEnabled() && typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : undefined,
    status: 'pending',
    createdAt: now,
    expiresAt: now + approvalTimeoutMs,
  };
  await store.createToolCallApproval(approval);

  const agentDefinition = await store.getAgentDefinition(agentId);
  const agentLabel = agentDefinition?.name ?? agentId;
  const fieldSuffix = approval.fieldPath ? ` (field: ${approval.fieldPath})` : '';
  await notifyAll(
    notifiers,
    {
      title: `Tool-call approval needed: ${tool}${fieldSuffix} (${agentLabel})`,
      severity: verdict.matchedRule?.severity ?? 'medium',
      reasons: approval.matchedReason ? [approval.matchedReason] : [],
      recommendedAction: `Approve or reject this ${tool} call before it executes`,
      approvalId: approval.id,
    },
    logger,
  );

  const deadline = now + approvalTimeoutMs;
  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      return { allowed: false, reason: 'request aborted while awaiting tool-call approval' };
    }
    const remainingMs = deadline - Date.now();
    await sleep(Math.min(pollIntervalMs, remainingMs));

    const current = await store.getToolCallApproval(approval.id);
    if (current && current.status !== 'pending') {
      if (current.status === 'approved') return { allowed: true };
      return { allowed: false, reason: `tool call ${current.status} via ${current.channel ?? 'unknown'}` };
    }
  }

  // Local timeout — self-resolve so nothing needs a background expiry timer.
  await store.resolveToolCallApproval(approval.id, timeoutDecision, 'system', 'timeout');
  if (timeoutDecision === 'approved') return { allowed: true };
  return { allowed: false, reason: 'timed out awaiting tool-call approval' };
}
