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
import type { Database } from '../db/client.js';
import { createNotifiers, type NotifierRegistry } from '../notify/index.js';

export interface Autopilot {
  store: StateStore;
  notifiers: NotifierRegistry;
  approvalService: ApprovalService;
  /**
   * Always constructed, even with AUTOPILOT_ENABLED=0. That flag governs
   * whether the PERIODIC scan timer runs (see `start()` in server.ts), not
   * whether on-demand scanning exists — an operator pressing "Scan now" is
   * asking for a verdict, which is exactly what someone who has opted out of
   * autonomous remediation still wants. When autopilot is off the policy
   * config is forced to shadow mode (see loadPolicyConfig), so a manual scan
   * reports what it WOULD do without doing it.
   */
  scheduler: AutopilotScheduler;
  /**
   * The Postgres handle, when that backend was selected. Passed on to
   * better-auth so human login shares this pool rather than opening a second
   * one; its absence means the deployment has no database and therefore no
   * console login (see auth/index.ts).
   */
  db?: Database;
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

  // Awaited: the Postgres backend migrates and seeds here, before anything can
  // read or write. Boot fails loudly on a bad schema rather than serving
  // traffic against one the code does not match.
  const { store, kind: storeKind, db } = await createStateStore({
    databaseUrl: serverConfig.databaseUrl,
    redisUrl: serverConfig.redisUrl,
    logger: {
      info: (message) => logger.info?.(message),
      error: (message, error) => logger.error?.(`${message}: ${String(error)}`),
    },
  });
  logger.info?.(`state store: ${storeKind}`);

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

  const scheduler = new AutopilotScheduler({
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

  return {
    store,
    notifiers,
    approvalService,
    scheduler,
    ...(db ? { db } : {}),
    async shutdown() {
      scheduler.stop();
      approvalService.stop();
      await store.close();
    },
  };
}
