/**
 * CLI entry point: `npm run drift` / `npm run drift:dry-run` (or as a cron).
 * Thin wrapper around @driftwatch/sdk's detectBehavioralDrift using this
 * server's configured model client and env-sourced config.
 */
import { detectBehavioralDrift, loadDriftWatchConfigFromEnv } from '@driftwatch/sdk';
import { loadServerConfigFromEnv } from '../config/server-config.js';
import { modelClient } from '../config/model-client.js';

const driftWatchConfig = loadDriftWatchConfigFromEnv();
const serverConfig = loadServerConfigFromEnv();

detectBehavioralDrift({
  modelClient,
  isDryRun: serverConfig.driftDryRun,
  driftDetectionConfig: driftWatchConfig.driftDetection,
})
  .then((driftReport) => {
    console.log(JSON.stringify(driftReport, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
