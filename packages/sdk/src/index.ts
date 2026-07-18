// --- config ---
export {
  DriftWatchConfigSchema,
  TelemetryConfigSchema,
  AgentConfigSchema,
  DriftDetectionConfigSchema,
  loadDriftWatchConfigFromEnv,
  type DriftWatchConfig,
  type TelemetryConfig,
  type AgentConfig,
  type DriftDetectionConfig,
} from './config/schema.js';

// --- model client ---
export {
  describeModelClient,
  assertModelClientIsConfigured,
  type ModelClient,
  type ModelClientDescriptor,
} from './model-client.js';

// --- agent ---
export {
  runAgentTask,
  type RunAgentTaskOptions,
  type AgentTaskResult,
} from './agent/runner.js';
export {
  estimateCostUsd,
  evaluateGuardrailBreach,
  sumStepUsage,
  buildTokenBudgetStopConditions,
  type AgentGuardrails,
  type CumulativeUsage,
  type GuardrailBreach,
} from './agent/guardrails.js';

// --- drift detection ---
export {
  detectBehavioralDrift,
  type DetectBehavioralDriftOptions,
  type DriftReport,
  type DriftVerdict,
  type WindowStats,
  type SigNozResponse,
} from './drift/detector.js';

// --- telemetry ---
export { bootstrapTelemetry } from './telemetry/otel.js';
export { AiSdkOtelIntegration } from './telemetry/ai-sdk-otel.js';
export {
  withSkillExecutionSpan,
  type WithSkillExecutionSpanOptions,
} from './telemetry/instrument.js';
export {
  summarizeTokenUsage,
  recordUsageOnSpan,
  type TokenUsageSummary,
} from './telemetry/usage-tracking.js';

// --- autopilot (Loop 2: drift-triggered remediation, pure decision layer) ---
export {
  ACTION_TYPES,
  CONTROL_ACTIONS,
  categorizeAction,
  type ActionType,
  type ActionCategory,
  type ActionIntent,
  type DriftSeverity,
  type Approval,
  type ApprovalStatus,
  type AgentRuntimeState,
  type AgentStatus,
  type DriftHistoryEntry,
  type ActionLogEntry,
  type ActionOutcome,
  type NotificationMessage,
  type StateStore,
  type Notifier,
} from './autopilot/types.js';
export {
  evaluatePolicies,
  computeWindowDeltas,
  PolicyConfigSchema,
  PolicyRuleSchema,
  PolicyConditionSchema,
  type PolicyConfig,
  type PolicyRule,
  type PolicyCondition,
  type WindowDeltas,
} from './autopilot/policy.js';
