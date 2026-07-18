/**
 * Loads the Autopilot PolicyConfig. Source precedence: inline JSON
 * (AUTOPILOT_POLICIES) > a policies file (AUTOPILOT_POLICIES_FILE) > a built-in
 * default. The env-level AUTOPILOT_MODE and AUTOPILOT_COOLDOWN_MS always win
 * over whatever the policy document says, so operators can flip enforce/shadow
 * without editing the policy file.
 *
 * File reading is I/O, so it lives here in the server — never in the SDK.
 */
import { readFileSync } from 'node:fs';
import { PolicyConfigSchema, type PolicyConfig } from '@driftwatch/sdk';
import type { ServerConfig } from './server-config.js';

/**
 * A sensible starting policy: escalate with severity, and always notify on a
 * big token-spend jump. Control actions (pause) only at high severity.
 */
const DEFAULT_POLICY: unknown = {
  rules: [
    {
      when: { severity: 'high' },
      do: ['notify_slack', 'notify_telegram', 'notify_webhook', 'pause_agent'],
    },
    {
      when: { severity: 'medium' },
      do: ['notify_slack', 'notify_telegram', 'notify_webhook'],
    },
    { when: { tokenSpendDeltaPct: 100 }, do: ['notify_webhook'] },
  ],
};

export function loadPolicyConfig(config: ServerConfig): PolicyConfig {
  let raw: unknown = DEFAULT_POLICY;

  if (config.policiesJson) {
    raw = JSON.parse(config.policiesJson);
  } else if (config.policiesFile) {
    raw = JSON.parse(readFileSync(config.policiesFile, 'utf8'));
  }

  const parsed = PolicyConfigSchema.parse(raw);
  // Env is authoritative for the operational knobs.
  return { ...parsed, mode: config.autopilotMode, cooldownMs: config.cooldownMs };
}
