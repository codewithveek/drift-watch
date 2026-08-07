/**
 * Autopilot scheduler — the autonomous perceive→reason→act loop (Loop 2),
 * now running over the whole registered fleet, not one implicit agent.
 *
 * Every SCAN_INTERVAL_MS the leader process (elected via the StateStore's
 * leader lock so only ONE process acts per cycle in a multi-process
 * deployment — this lock is GLOBAL, not per-agent: one leader loops the whole
 * fleet sequentially within a tick) walks `store.listAgents()` and, for each:
 *   1. perceive — detectBehavioralDrift over that agent's metrics-source
 *      windows (or fixtures); agents with no metrics source (no serviceName
 *      registered) are skipped — they're tracked for approvals/control only.
 *   2. reason   — evaluatePolicies maps the report to ActionIntents,
 *   3. act      — notify_* intents fire immediately; control intents open an
 *                 approval. A per-agent, per-action cooldown dedups storms.
 *
 * In `shadow` mode nothing is executed: intended actions are logged only, which
 * is the safe default and the CI/demo path.
 */
import { randomUUID } from 'node:crypto';
import { detectBehavioralDrift, type DriftReport } from '../drift/detector.js';
import type { ModelClient } from '../model-client.js';
import type { MetricsQuerySource } from '../drift/metrics-source.js';
import { evaluatePolicies, type PolicyConfig } from './policy.js';
import type { ActionIntent, ActionLogEntry, AgentDefinition, StateStore } from './types.js';
import type { ApprovalService } from './approval-service.js';
import {
  notifierForAction,
  safeNotify,
  type NotifierRegistry,
} from './notify-dispatch.js';

const LEADER_LOCK_KEY = 'scheduler:leader';

export interface SchedulerLogger {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface AgentCycleResult {
  agentId: string;
  report?: DriftReport;
  intents: ActionIntent[];
  /** Set when drift detection was skipped for this agent (no metrics source). */
  skipped?: 'no-metrics-source';
}

export interface AutopilotSchedulerOptions {
  store: StateStore;
  notifiers: NotifierRegistry;
  approvalService: ApprovalService;
  modelClient: ModelClient;
  policyConfig: PolicyConfig;
  /**
   * Builds a MetricsQuerySource for one agent, or undefined if that agent has
   * no serviceName registered (drift detection is skipped for it — it's
   * tracked for approvals/control only).
   */
  metricsQuerySourceFor: (agent: AgentDefinition) => MetricsQuerySource | undefined;
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
   * Run one drift cycle for every registered agent, sequentially (one leader
   * process handles the whole fleet per tick — not worth concurrent-query
   * complexity or interleaved notifications at expected fleet sizes; revisit
   * if that changes). Exposed so the control-plane's fleet-wide
   * POST /drift/scan can trigger a manual run.
   */
  async runCycle(trigger: string): Promise<{ results: AgentCycleResult[] }> {
    const agents = await this.options.store.listAgents();
    const results: AgentCycleResult[] = [];
    for (const agent of agents) {
      results.push(await this.runAgentCycle(agent, trigger));
    }
    return { results };
  }

  /**
   * Run one drift cycle for a single agent. Exposed so the control-plane's
   * per-agent POST /agents/:agentId/drift/scan can trigger a manual run
   * without cycling the whole fleet.
   */
  async runCycleForAgent(agentId: string, trigger: string): Promise<AgentCycleResult> {
    const agent = await this.options.store.getAgentDefinition(agentId);
    if (!agent) {
      throw new Error(`unknown agent: ${agentId}`);
    }
    return this.runAgentCycle(agent, trigger);
  }

  private async runAgentCycle(agent: AgentDefinition, trigger: string): Promise<AgentCycleResult> {
    const { store, modelClient, metricsQuerySourceFor, isDryRun, policyConfig } = this.options;

    const metricsQuerySource = metricsQuerySourceFor(agent);
    if (!metricsQuerySource && !isDryRun) {
      return { agentId: agent.id, intents: [], skipped: 'no-metrics-source' };
    }

    const report = await detectBehavioralDrift({ modelClient, isDryRun, metricsQuerySource });

    await store.recordDriftVerdict(agent.id, {
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
      await this.dispatchIntent(agent, intent, trigger);
    }

    return { agentId: agent.id, report, intents };
  }

  private async dispatchIntent(
    agent: AgentDefinition,
    intent: ActionIntent,
    trigger: string,
  ): Promise<void> {
    const { store, policyConfig, cooldownMs, logger } = this.options;
    const isShadow = policyConfig.mode === 'shadow';

    // Cooldown dedup — one entry per agent per action type per window.
    const mayProceed = await store.checkAndSetCooldown(
      agent.id,
      `action:${intent.type}`,
      cooldownMs,
    );
    if (!mayProceed) {
      await this.recordOutcome(agent, intent, 'skipped_cooldown', trigger);
      return;
    }

    if (isShadow) {
      logger.info(
        { agentId: agent.id, intent, trigger },
        'autopilot shadow: intended action (not executed)',
      );
      await this.recordOutcome(agent, intent, 'shadowed', trigger);
      return;
    }

    if (intent.category === 'notify') {
      await this.dispatchNotify(agent, intent, trigger);
    } else {
      await this.dispatchControl(agent, intent, trigger);
    }
  }

  private async dispatchNotify(
    agent: AgentDefinition,
    intent: ActionIntent,
    trigger: string,
  ): Promise<void> {
    const { notifiers, logger } = this.options;
    const notifier = notifierForAction(notifiers, intent.type);
    if (!notifier) {
      logger.info({ agentId: agent.id, intent }, 'notify action skipped: channel not configured');
      await this.recordOutcome(agent, intent, 'failed', trigger);
      return;
    }
    await safeNotify(
      notifier,
      {
        title: `Behavioral drift detected (${agent.name})`,
        severity: intent.severity,
        reasons: intent.reason ? [intent.reason] : [],
        recommendedAction: intent.reason || 'Review the drift report.',
        action: intent.type,
      },
      logger,
    );
    await this.recordOutcome(agent, intent, 'executed', trigger);
  }

  private async dispatchControl(
    agent: AgentDefinition,
    intent: ActionIntent,
    trigger: string,
  ): Promise<void> {
    await this.options.approvalService.requestApproval(agent.id, intent);
    await this.recordOutcome(agent, intent, 'pending_approval', trigger);
  }

  private async recordOutcome(
    agent: AgentDefinition,
    intent: ActionIntent,
    outcome: ActionLogEntry['outcome'],
    trigger: string,
  ): Promise<void> {
    await this.options.store.recordAction(agent.id, {
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
