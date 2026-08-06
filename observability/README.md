# Observability stack

Config for the reference OTel Collector + Prometheus pair used by
`docker-compose.observability.yml` and `docker-compose.coolify.yml`:

- `otel-collector/otel-collector-config.yaml` — receives OTLP (traces,
  metrics, logs) from a DriftWatch-instrumented agent and re-exposes metrics
  as a Prometheus scrape target. Traces/logs go to the `debug` exporter
  (stdout) in this reference config — swap in Tempo/Loki/Jaeger/etc. if you
  want them stored rather than just printed.
- `prometheus/prometheus.yml` — scrapes the collector's Prometheus exporter.
  This is the backend `PrometheusMetricsSource`
  (`packages/sdk/src/drift/prometheus-source.ts`) queries for the drift
  detector's window stats, and what `PROMETHEUS_URL` should point at.

Neither file is DriftWatch-specific beyond the metric names the collector
happens to be receiving (`agent.tool.calls`, `agent.tool.duration`,
`agent.tokens`, `agent.model.switches`) — point an existing Prometheus/OTel
Collector deployment at the same OTLP endpoint instead of running these if
you already have one.

Generate some traffic against a DriftWatch server before checking Prometheus
for data — an idle agent has nothing to scrape yet.
