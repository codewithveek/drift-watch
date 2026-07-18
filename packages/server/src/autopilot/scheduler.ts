/**
 * Autopilot scheduler — the autonomous perceive→reason→act loop (Loop 2).
 *
 * Every SCAN_INTERVAL_MS the leader process (elected via a Redis SET-NX lock so
 * only ONE process acts per cycle in a multi-process deployment):
 *   1. perceive — detectBehavioralDrift over the SigNoz windows (or fixtures),
 *   2. reason   — evaluatePolicies maps the report to ActionIntents,
 *   3. act      — notify_* intents fire immediately; control intents open an
 *                 approval. A per-action cooldown dedups storms.
 *
 * In `shadow` mode nothing is executed: intended actions are logged only, which
 * is the safe default and the CI/demo path.
 */
import {
  detectBehavioralDrift,
  evaluatePolicies,
  type ActionIntent,
  type ActionLogEntry,
  type DriftDetectionConfig,
  type DriftReport,
  type ModelClient,
  type PolicyConfig,
  type StateStore,
} from '@driftwatch/sdk';
import { randomUUID } from 'node:crypto';
import type { ApprovalService } from './approval-service.js';
import {
  notifierForAction,
  safeNotify,
  type NotifierRegistry,
} from '../notify/index.js';

const LEADER_LOCK_KEY = 'scheduler:leader';

export interface SchedulerLogger {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface AutopilotSchedulerOptions {
  store: StateStore;
  notifiers: NotifierRegistry;
  approvalService: ApprovalService;
  modelClient: ModelClient;
  policyConfig: PolicyConfig;
  driftDetectionConfig: DriftDetectionConfig;
  isDryRun: boolean;
  scanIntervalMs: number;
  cooldownMs: number;
  logger: SchedulerLogger;
}

export class AutopilotScheduler {
  private readonly options: AutopilotSchedulerOptions;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(options: AutopilotSchedulerOptions) {
    this.options = options;
  }

  /** Begin the periodic loop. The first cycle runs after one interval. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.scanIntervalMs);
    this.timer.unref?.();
    this.options.logger.info(
      { intervalMs: this.options.scanIntervalMs, mode: this.options.policyConfig.mode },
      'autopilot scheduler started',
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One guarded tick: only the elected leader runs a cycle. */
  private async tick(): Promise<void> {
    if (this.running) return; // never overlap cycles within a process
    const isLeader = await this.options.store.acquireLeaderLock(
      LEADER_LOCK_KEY,
      this.options.scanIntervalMs,
    );
    if (!isLeader) return;

    this.running = true;
    try {
      await this.runCycle('scheduler');
    } catch (error) {
      this.options.logger.error({ error }, 'autopilot cycle failed');
    } finally {
      this.running = false;
    }
  }

  /**
   * Run a single drift cycle end to end. Exposed so the control-plane's
   * POST /drift/scan can trigger a manual run. Returns the report + intents
   * for the caller to surface.
   */
  async runCycle(
    trigger: string,
  ): Promise<{ report: DriftReport; intents: ActionIntent[] }> {
    const { store, modelClient, driftDetectionConfig, isDryRun, policyConfig } =
      this.options;

    const report = await detectBehavioralDrift({
      modelClient,
      isDryRun,
      driftDetectionConfig,
    });

    await store.recordDriftVerdict({
      id: randomUUID(),
      at: Date.now(),
      drift: report.verdict.drift,
      severity: report.verdict.severity,
      reasons: report.verdict.reasons,
      recommendedAction: report.verdict.recommended_action,
      baselineTokenSpend: report.baselineWindowStats.tokenSpend,
      currentTokenSpend: report.currentWindowStats.tokenSpend,
    });

    const intents = evaluatePolicies(report, policyConfig);
    for (const intent of intents) {
      await this.dispatchIntent(intent, trigger);
    }

    return { report, intents };
  }

  private async dispatchIntent(intent: ActionIntent, trigger: string): Promise<void> {
    const { store, policyConfig, cooldownMs, logger } = this.options;
    const isShadow = policyConfig.mode === 'shadow';

    // Cooldown dedup — one entry per action type per window.
    const mayProceed = await store.checkAndSetCooldown(
      `action:${intent.type}`,
      cooldownMs,
    );
    if (!mayProceed) {
      await this.recordOutcome(intent, 'skipped_cooldown', trigger);
      return;
    }

    if (isShadow) {
      logger.info({ intent, trigger }, 'autopilot shadow: intended action (not executed)');
      await this.recordOutcome(intent, 'shadowed', trigger);
      return;
    }

    if (intent.category === 'notify') {
      await this.dispatchNotify(intent, trigger);
    } else {
      await this.dispatchControl(intent, trigger);
    }
  }

  private async dispatchNotify(intent: ActionIntent, trigger: string): Promise<void> {
    const { notifiers, logger } = this.options;
    const notifier = notifierForAction(notifiers, intent.type);
    if (!notifier) {
      logger.info({ intent }, 'notify action skipped: channel not configured');
      await this.recordOutcome(intent, 'failed', trigger);
      return;
    }
    await safeNotify(
      notifier,
      {
        title: 'Behavioral drift detected',
        severity: intent.severity,
        reasons: intent.reason ? [intent.reason] : [],
        recommendedAction: intent.reason || 'Review the drift report.',
        action: intent.type,
      },
      logger,
    );
    await this.recordOutcome(intent, 'executed', trigger);
  }

  private async dispatchControl(intent: ActionIntent, trigger: string): Promise<void> {
    await this.options.approvalService.requestApproval(intent);
    await this.recordOutcome(intent, 'pending_approval', trigger);
  }

  private async recordOutcome(
    intent: ActionIntent,
    outcome: ActionLogEntry['outcome'],
    trigger: string,
  ): Promise<void> {
    await this.options.store.recordAction({
      id: randomUUID(),
      at: Date.now(),
      action: intent.type,
      category: intent.category,
      outcome,
      reason: intent.reason,
      actor: 'autopilot',
      channel: trigger,
    });
  }
}
