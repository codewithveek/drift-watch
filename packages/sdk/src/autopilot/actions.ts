/**
 * Control-action executor — the "act" half of Loop 2.
 *
 * These functions mutate the *shared* runtime state (via the StateStore) so
 * that every process and the console converge on the same posture. Control
 * actions are only ever executed here: the scheduler enqueues them behind an
 * approval, and the approval service calls back into this module once a human
 * (from the console, Slack, or Telegram) has said yes.
 *
 * Notify actions are NOT handled here — they are safe side effects dispatched
 * directly through the notifiers by the scheduler/approval service.
 */
import { trace, metrics, type Counter } from '@opentelemetry/api';
import type {
  ActionLogEntry,
  ActionType,
  AgentRuntimeState,
  DriftSeverity,
  StateStore,
} from './types.js';
import { randomUUID } from 'node:crypto';

const tracer = trace.getTracer('driftwatch');

/**
 * Lazily created (see instrument.ts for why module-load creation binds to a
 * no-op meter): counts Autopilot model switches so the drift detector can tell
 * an *intentional* switch from unexplained drift, and so a switch is visible on
 * a dashboard. Paired with the `agent.model.switch` span below, which puts the
 * same event on the trace timeline for correlation and for SigNoz MCP.
 */
let cachedSwitchCounter: Counter | undefined;
function getModelSwitchCounter(): Counter {
  if (!cachedSwitchCounter) {
    cachedSwitchCounter = metrics
      .getMeter('driftwatch')
      .createCounter('agent.model.switches', {
        description: 'Count of Autopilot-initiated model switches, by from/to model',
      });
  }
  return cachedSwitchCounter;
}

/**
 * Emit the observability marker for an applied model switch: a short span (for
 * trace-timeline correlation — you can see the switch right before the behavior
 * change, and SigNoz MCP can explain it) plus a counter increment (the
 * low-cardinality signal the drift detector queries to avoid flagging the
 * intended change as drift). `from` is the model before the switch, `to` after.
 */
function recordModelSwitchMarker(
  from: string | undefined,
  to: string,
  reason: string,
): void {
  const attributes = {
    'agent.model.from': from ?? 'default',
    'agent.model.to': to,
    'agent.control.reason': reason,
  };
  tracer.startSpan('agent.model.switch', { attributes }).end();
  getModelSwitchCounter().add(1, { from_model: from ?? 'default', to_model: to });
}

export interface ControlActionContext {
  /** Free-text reason recorded to the audit log. */
  reason: string;
  /** Who triggered it (e.g. a Slack user id, "console", "scheduler"). */
  actor?: string;
  /** Which surface triggered it: 'console' | 'slack' | 'telegram' | 'system'. */
  channel?: string;
  severity?: DriftSeverity;
  /** Target model id for switch_model. */
  targetModel?: string;
}

export interface ControlActionResult {
  action: ActionType;
  applied: boolean;
  state: AgentRuntimeState;
}

/**
 * Apply a single control action to the shared agent state and append an audit
 * record. Returns the resulting state. Notify actions are rejected here — they
 * do not belong on the control path.
 */
export async function executeControlAction(
  store: StateStore,
  action: ActionType,
  context: ControlActionContext,
): Promise<ControlActionResult> {
  const current = await store.getAgentState();
  const next = applyAction(current, action, context);
  const applied = next !== current;

  if (applied) {
    await store.setAgentState(next);
    if (action === 'switch_model') {
      recordModelSwitchMarker(current.activeModel, next.activeModel ?? '', context.reason);
    }
  }

  await store.recordAction(toLogEntry(action, applied, context));

  return { action, applied, state: next };
}

/**
 * Pure state transition for a control action. Returns the SAME object when the
 * action is a no-op (e.g. resuming an already-running agent) so callers can
 * detect whether anything changed.
 */
function applyAction(
  current: AgentRuntimeState,
  action: ActionType,
  context: ControlActionContext,
): AgentRuntimeState {
  const now = Date.now();
  const base: AgentRuntimeState = { ...current, updatedAt: now, reason: context.reason };

  switch (action) {
    case 'pause_agent':
      if (current.status === 'paused') return current;
      return { ...base, status: 'paused' };

    case 'resume_agent':
      if (current.status === 'running') return current;
      return { ...base, status: 'running' };

    case 'throttle':
      if (current.status === 'throttled') return current;
      return { ...base, status: 'throttled' };

    case 'rollback': {
      // Roll back to the last-known-good version pointer (floor at 1).
      const target = Math.max(1, current.activeVersion - 1);
      if (target === current.activeVersion) return current;
      return { ...base, activeVersion: target };
    }

    case 'switch_model': {
      const target = context.targetModel;
      if (!target || target === current.activeModel) return current;
      return { ...base, activeModel: target };
    }

    // Notify actions are not control actions and must not reach this path.
    case 'notify_slack':
    case 'notify_telegram':
    case 'notify_webhook':
      throw new Error(`executeControlAction called with notify action: ${action}`);

    default: {
      const exhaustive: never = action;
      throw new Error(`Unhandled control action: ${String(exhaustive)}`);
    }
  }
}

function toLogEntry(
  action: ActionType,
  applied: boolean,
  context: ControlActionContext,
): ActionLogEntry {
  return {
    id: randomUUID(),
    at: Date.now(),
    action,
    category: 'control',
    outcome: applied ? 'executed' : 'skipped_cooldown',
    reason: applied ? context.reason : `${context.reason} (no-op)`,
    actor: context.actor,
    channel: context.channel,
  };
}
