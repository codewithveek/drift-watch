// --- config ---
export {
  DriftWatchConfigSchema,
  TelemetryConfigSchema,
  AgentConfigSchema,
  DriftDetectionConfigSchema,
  loadDriftWatchConfigFromEnv,
  resolveAgentConfig,
  toAgentGuardrails,
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
// --- the front door --------------------------------------------------------
export {
  DriftWatchAgent,
  type DriftWatchAgentOptions,
  type RunAgentOptions,
} from './agent/driftwatch-agent.js';
export {
  ControlPlaneClient,
  ControlPlaneError,
  type ControlPlaneClientOptions,
  type EffectiveAgentConfig,
  type AgentDeclaration,
} from './agent/control-plane.js';
export {
  createAgentRuntime,
  type AgentRuntime,
  type AgentSource,
  type CreateAgentRuntimeOptions,
  type SkillCallOptions,
  type RunOptions,
} from './agent/runtime.js';
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
  ToolCallDeniedError,
  type WithSkillExecutionSpanOptions,
} from './telemetry/instrument.js';
export {
  summarizeTokenUsage,
  recordUsageOnSpan,
  recordTokenUsageMetric,
  type TokenUsageSummary,
} from './telemetry/usage-tracking.js';
export { buildAgentLabels } from './telemetry/agent-labels.js';

// --- autopilot (Loop 2: drift-triggered remediation, pure decision layer) ---
export {
  ACTION_TYPES,
  CONTROL_ACTIONS,
  AGENT_ID_PATTERN,
  AUDIT_ACTIONS,
  generateAgentSlug,
  categorizeAction,
  resolveToolCallPolicies,
  type AuditAction,
  type AuditEvent,
  type ActionType,
  type ActionCategory,
  type ActionIntent,
  type DriftSeverity,
  type Approval,
  type ApprovalStatus,
  type ToolCallApproval,
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
// --- layered agent config (code baseline <- console overrides) --------------
export {
  applyAgentOverride,
  overriddenFields,
  isEmptyOverride,
  OVERRIDABLE_FIELDS,
  type AgentOverride,
  type OverridableField,
} from './autopilot/agent-override.js';
// --- typed policy authoring (compile-time overlay on ToolCallPolicyRule) ----
export {
  toRuntimeRule,
  type ToolPolicy,
  type Condition,
  type FieldPath,
  type InputOf,
  type Paths,
  type ToolName,
  type ValueAtPath,
} from './agent/policy-authoring.js';
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
export {
  evaluateToolCallPolicy,
  getByPath,
  ToolCallPolicyRuleSchema,
  ToolCallConditionSchema,
  type ToolCallPolicyRule,
  type ToolCallCondition,
  type ToolCallGateAction,
  type ToolCallPolicyVerdict,
} from './autopilot/tool-call-policy.js';
export {
  gateToolCall,
  type GateToolCallOptions,
  type GateToolCallResult,
  type ToolCallApprovalTransport,
} from './autopilot/tool-call-gate.js';
export {
  API_KEY_SCOPES,
  API_KEY_SCOPE_DESCRIPTIONS,
  API_KEY_TOKEN_PREFIX,
  API_KEY_TOUCH_INTERVAL_MS,
  hashApiKeyToken,
  isApiKeyFleetWide,
  isApiKeyScope,
  mintApiKey,
  toPublicApiKey,
  type ApiKeyRecord,
  type ApiKeyScope,
  type MintApiKeyOptions,
  type MintedApiKey,
  type PublicApiKey,
} from './autopilot/api-keys.js';
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
