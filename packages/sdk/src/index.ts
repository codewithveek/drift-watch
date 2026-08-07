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
} from './drift/detector.js';
export { type WindowStats, type MetricsQuerySource } from './drift/metrics-source.js';
export {
  PrometheusMetricsSource,
  type PrometheusMetricsSourceOptions,
  type PrometheusMetricNames,
} from './drift/prometheus-source.js';

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
  AGENT_ID_PATTERN,
  categorizeAction,
  type ActionType,
  type ActionCategory,
  type ActionIntent,
  type DriftSeverity,
  type Approval,
  type ApprovalStatus,
  type AgentRuntimeState,
  type AgentStatus,
  type AgentDefinition,
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
export { MemoryStateStore } from './autopilot/memory-store.js';
export {
  notifierForAction,
  safeNotify,
  notifyAll,
  type NotifierRegistry,
  type DispatchLogger,
} from './autopilot/notify-dispatch.js';
export {
  executeControlAction,
  type ControlActionContext,
  type ControlActionResult,
} from './autopilot/actions.js';
export {
  ApprovalService,
  type ApprovalDecision,
  type ApprovalServiceOptions,
} from './autopilot/approval-service.js';
export {
  AutopilotScheduler,
  type SchedulerLogger,
  type AutopilotSchedulerOptions,
  type AgentCycleResult,
} from './autopilot/scheduler.js';
