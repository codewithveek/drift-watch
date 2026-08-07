/**
 * Autopilot composition root. Builds the shared StateStore, the notifier
 * registry, the approval service, and (when enabled) the scheduler from typed
 * config. Kept out of server.ts so the wiring is testable and server.ts stays
 * a thin bootstrap.
 *
 * ApprovalService and AutopilotScheduler are @driftwatch/sdk orchestration —
 * this file only supplies the concrete StateStore and NotifierRegistry they
 * run against.
 */
import type { DriftWatchConfig, ModelClient, StateStore } from '@driftwatch/sdk';
import {
  ApprovalService,
  AutopilotScheduler,
  type SchedulerLogger,
} from '@driftwatch/sdk';
import type { ServerConfig } from '../config/server-config.js';
import { loadPolicyConfig } from '../config/policy-loader.js';
import { createMetricsQuerySourceFor } from '../config/metrics-source.js';
import { createStateStore } from '../state/index.js';
import { createNotifiers, type NotifierRegistry } from '../notify/index.js';

export interface Autopilot {
  store: StateStore;
  notifiers: NotifierRegistry;
  approvalService: ApprovalService;
  /** Only present when AUTOPILOT_ENABLED=1. */
  scheduler?: AutopilotScheduler;
  /** Ordered teardown: stop timers, then close the store. */
  shutdown(): Promise<void>;
}

export async function createAutopilot(options: {
  serverConfig: ServerConfig;
  driftWatchConfig: DriftWatchConfig;
  modelClient: ModelClient;
  logger: SchedulerLogger;
}): Promise<Autopilot> {
  const { serverConfig, driftWatchConfig, modelClient, logger } = options;

  const store = createStateStore(serverConfig.redisUrl);

  // Backward-compat auto-registration: if no agents are registered yet,
  // register one derived from this server's own config, so existing
  // single-agent deployments (docker-compose.yml et al.) need zero new
  // configuration. Idempotent — a second process racing on an empty registry
  // just upserts the same id, which is harmless.
  const existingAgents = await store.listAgents();
  if (existingAgents.length === 0) {
    await store.upsertAgent({
      id: serverConfig.agentId,
      name: serverConfig.agentName || driftWatchConfig.telemetry.serviceName,
      serviceName: driftWatchConfig.telemetry.serviceName,
      createdAt: Date.now(),
    });
  }

  const notifiers = createNotifiers(serverConfig);
  const approvalService = new ApprovalService({
    store,
    notifiers,
    approvalTimeoutMs: serverConfig.approvalTimeoutMs,
    timeoutDecision: serverConfig.approvalTimeoutDecision,
    switchModelTo: serverConfig.switchModelTo,
    logger,
  });

  let scheduler: AutopilotScheduler | undefined;
  if (serverConfig.autopilotEnabled) {
    scheduler = new AutopilotScheduler({
      store,
      notifiers,
      approvalService,
      modelClient,
      policyConfig: loadPolicyConfig(serverConfig),
      metricsQuerySourceFor: (agent) =>
        createMetricsQuerySourceFor(driftWatchConfig.driftDetection, agent),
      isDryRun: serverConfig.driftDryRun,
      scanIntervalMs: serverConfig.scanIntervalMs,
      cooldownMs: serverConfig.cooldownMs,
      logger,
    });
  }

  return {
    store,
    notifiers,
    approvalService,
    scheduler,
    async shutdown() {
      scheduler?.stop();
      approvalService.stop();
      await store.close();
    },
  };
}
