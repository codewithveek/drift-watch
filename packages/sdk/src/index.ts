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
