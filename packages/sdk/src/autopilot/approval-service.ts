/**
 * Approval service — creates and resolves human-in-the-loop approvals for
 * control actions, and executes the action once approved.
 *
 * Resolution is channel-agnostic: the console, a Slack button, and a Telegram
 * button all call `resolve(...)`, which delegates to the StateStore's ATOMIC
 * resolveApproval (a Redis Lua CAS, or a guarded map write in memory). That
 * atomicity is what makes approvals safe across processes and idempotent under
 * double-clicks — whoever wins the CAS executes the action exactly once.
 *
 * On creation we arm a timeout so a forgotten approval falls back to a safe
 * default (reject, by default) rather than hanging a paused agent forever.
 */
import { randomUUID } from 'node:crypto';
import type { ActionIntent, Approval, StateStore } from './types.js';
import { executeControlAction } from './actions.js';
import { notifyAll, type DispatchLogger, type NotifierRegistry } from './notify-dispatch.js';

export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalServiceOptions {
  store: StateStore;
  notifiers: NotifierRegistry;
  approvalTimeoutMs: number;
  timeoutDecision: ApprovalDecision;
  logger?: DispatchLogger;
}

export class ApprovalService {
  private readonly store: StateStore;
  private readonly notifiers: NotifierRegistry;
  private readonly approvalTimeoutMs: number;
  private readonly timeoutDecision: ApprovalDecision;
  private readonly logger?: DispatchLogger;
  /** Live timeout handles, so we can cancel on resolve and on shutdown. */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(options: ApprovalServiceOptions) {
    this.store = options.store;
    this.notifiers = options.notifiers;
    this.approvalTimeoutMs = options.approvalTimeoutMs;
    this.timeoutDecision = options.timeoutDecision;
    this.logger = options.logger;
  }

  /**
   * Create a pending approval for a control action intent, broadcast it to
   * every notifier (with Approve/Reject affordances), and arm the timeout.
   */
  async requestApproval(intent: ActionIntent): Promise<Approval> {
    const now = Date.now();
    const approval: Approval = {
      id: randomUUID(),
      action: intent.type,
      severity: intent.severity,
      reasons: intent.reason ? [intent.reason] : [],
      recommendedAction: `Autopilot proposes: ${intent.type}`,
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.approvalTimeoutMs,
    };
    await this.store.createApproval(approval);

    await notifyAll(
      this.notifiers,
      {
        title: `Approval needed: ${intent.type}`,
        severity: intent.severity,
        reasons: approval.reasons,
        recommendedAction: approval.recommendedAction,
        approvalId: approval.id,
        action: intent.type,
      },
      this.logger,
    );

    this.armTimeout(approval.id);
    return approval;
  }

  /**
   * Resolve an approval from any channel. Idempotent: only the first caller to
   * win the store's atomic CAS executes the action; later calls return
   * undefined. Returns the resolved approval, or undefined if it was missing
   * or already resolved.
   */
  async resolve(
    id: string,
    decision: ApprovalDecision,
    actor: string,
    channel: string,
  ): Promise<Approval | undefined> {
    const resolved = await this.store.resolveApproval(id, decision, actor, channel);
    if (!resolved) return undefined;

    this.clearTimeout(id);

    if (decision === 'approved') {
      await executeControlAction(this.store, resolved.action, {
        reason: `approved via ${channel} by ${actor}`,
        actor,
        channel,
        severity: resolved.severity,
      });
    }

    return resolved;
  }

  /** Cancel all pending timers (called on ordered shutdown). */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private armTimeout(id: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(id);
      // Resolve with the configured safe default; 'timeout' marks the channel.
      void this.resolve(id, this.timeoutDecision, 'autopilot', 'timeout').catch(
        (error) => this.logger?.error({ error, id }, 'approval timeout resolve failed'),
      );
    }, this.approvalTimeoutMs);
    // Don't keep the event loop alive solely for a pending approval.
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private clearTimeout(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}
