/**
 * `MetricsQuerySource` backed by this deployment's own Postgres.
 *
 * This is the piece that makes Prometheus OPTIONAL rather than required.
 *
 * `detectBehavioralDrift` never knew where its window statistics came from — it
 * takes a `MetricsQuerySource`, and `PrometheusMetricsSource` was simply the only
 * implementation. That abstraction was written for exactly this: a second
 * implementation reading the run and tool-call records the control plane already
 * stores, producing the identical `WindowStats`, with no change to the detector,
 * the scheduler, or the policy engine.
 *
 * ## When each is used
 *
 * Prometheus wins when configured, because a deployment that has gone to the
 * trouble of running one has richer data than DriftWatch's own summaries: every
 * OTel metric, at full resolution, including from processes that never report
 * runs here. This is the fallback that makes a two-container deployment viable,
 * not a replacement for real observability infrastructure.
 *
 * ## What it cannot see
 *
 * Only what has been reported. An agent that never calls `run()` — or one whose
 * reports are failing — is invisible here in a way it would not be to Prometheus,
 * which scrapes independently. That is the honest trade for removing a container,
 * and it is why the drift detector's existing "no data" handling matters: an
 * empty window must read as "nothing happened", never as "everything is fine".
 */
import type { MetricsQuerySource, StateStore, WindowStats } from '@driftwatch/sdk';
import { queryModelSwitches, queryWindow } from './runs.js';

export interface SqlMetricsSourceOptions {
  store: StateStore;
  agentId: string;
}

export class SqlMetricsSource implements MetricsQuerySource {
  private readonly store: StateStore;
  private readonly agentId: string;

  constructor(options: SqlMetricsSourceOptions) {
    this.store = options.store;
    this.agentId = options.agentId;
  }

  async queryWindowStats(options: {
    windowLabel: string;
    startTimeMs: number;
    endTimeMs: number;
  }): Promise<WindowStats> {
    return queryWindow(
      this.store,
      this.agentId,
      options.windowLabel,
      options.startTimeMs,
      options.endTimeMs,
    );
  }

  /**
   * Resolves to 0 rather than rejecting when there is nothing to count — the
   * interface asks for this explicitly, because "no switches happened" and
   * "couldn't check" must not be conflated by the drift judge.
   */
  async queryModelSwitchCount(options: {
    startTimeMs: number;
    endTimeMs: number;
  }): Promise<number> {
    return queryModelSwitches(this.store, this.agentId, options.startTimeMs, options.endTimeMs);
  }
}
