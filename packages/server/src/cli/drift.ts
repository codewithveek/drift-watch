/**
 * CLI entry point: `npm run drift` / `npm run drift:dry-run` (or as a cron).
 * Thin wrapper around @driftwatch/sdk's detectBehavioralDrift using this
 * server's configured model client and env-sourced config.
 */
import 'dotenv/config';
import { detectBehavioralDrift, loadDriftWatchConfigFromEnv } from '@driftwatch/sdk';
import { loadServerConfigFromEnv } from '../config/server-config.js';
import { modelClient } from '../config/model-client.js';
import { createMetricsQuerySourceFor } from '../config/metrics-source.js';

const driftWatchConfig = loadDriftWatchConfigFromEnv();
const serverConfig = loadServerConfigFromEnv();

// The CLI doesn't share state with a running server (no store round-trip),
// so it builds an ad hoc AgentDefinition from its own config rather than
// looking one up from the registry.
const agent = {
  id: serverConfig.agentId,
  name: serverConfig.agentName || driftWatchConfig.telemetry.serviceName,
  serviceName: driftWatchConfig.telemetry.serviceName,
  createdAt: Date.now(),
};

detectBehavioralDrift({
  modelClient,
  isDryRun: serverConfig.driftDryRun,
  metricsQuerySource: createMetricsQuerySourceFor(driftWatchConfig.driftDetection, agent),
})
  .then((driftReport) => {
    console.log(JSON.stringify(driftReport, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
