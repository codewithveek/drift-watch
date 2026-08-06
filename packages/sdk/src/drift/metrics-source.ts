/**
 * Pluggable data source for the drift detector's window-stats query.
 *
 * `detectBehavioralDrift` (./detector.ts) needs two aggregate windows of
 * agent behavior (tool-call mix/error rate, p95 tool latency, token spend) to
 * hand the drift judge. Where those aggregates come from is intentionally an
 * interface, not a baked-in vendor call — the same "bring your own concrete
 * implementation" shape as StateStore/Notifier (../autopilot/types.ts).
 * `./prometheus-source.ts` ships a default implementation for the common
 * self-hosted case (Prometheus, Grafana Mimir/Cortex/Thanos, or any other
 * PromQL-compatible backend); consumers targeting a different metrics
 * backend implement this interface directly instead.
 */
export interface WindowStats {
  windowLabel: string;
  totalCalls: number;
  errorRate: number;
  p95LatencyMs: number;
  tokenSpend: number;
  toolMix: Record<string, number>;
}

export interface MetricsQuerySource {
  /** Aggregate tool-call mix, error rate, p95 latency, and token spend over one window. */
  queryWindowStats(options: {
    windowLabel: string;
    startTimeMs: number;
    endTimeMs: number;
  }): Promise<WindowStats>;

  /**
   * Count Autopilot-initiated model switches (the `agent.model.switches`
   * counter emitted by executeControlAction) in a window, so the drift judge
   * can be told a behavior change was intentional rather than organic drift.
   * Resolve to 0 rather than reject when the metric simply doesn't exist yet
   * (e.g. before Autopilot has ever switched a model) — detector.ts's
   * queryModelSwitchNote already treats a thrown error the same way
   * (fail-safe: worst case a switch isn't discounted), so this only matters
   * for distinguishing "no switches happened" from "couldn't check."
   */
  queryModelSwitchCount(options: { startTimeMs: number; endTimeMs: number }): Promise<number>;
}
