/**
 * Process-wide toggle for whether raw prompt text and tool-call inputs get
 * attached to spans as attributes. Set once by `bootstrapTelemetry` from
 * `TelemetryConfig.capturePayloads` (see ../config/schema.ts) rather than
 * threaded as a parameter through every call site — `runAgentTask` and
 * `withSkillExecutionSpan` are called per-request, while this is a
 * deployment-wide decision made once at startup, same as the rest of
 * telemetry bootstrapping.
 *
 * Defaults to true so behavior is unchanged unless a deployment opts out
 * (e.g. because prompts/tool inputs may carry PII or secrets that shouldn't
 * land in the tracing backend). Span/metric names and numeric usage data are
 * still emitted either way — only the raw payload attributes are gated.
 */
let capturePayloadsEnabled = true;

export function setCapturePayloadsEnabled(enabled: boolean): void {
  capturePayloadsEnabled = enabled;
}

export function isCapturePayloadsEnabled(): boolean {
  return capturePayloadsEnabled;
}
