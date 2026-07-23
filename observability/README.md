# SigNoz dashboard

`signoz-dashboard.json` is a ready-to-import SigNoz dashboard for a
DriftWatch-instrumented agent — three panels covering tool-call mix, per-tool
p95 latency, and token spend by model, built from the `agent.tool.calls`,
`agent.tool.duration`, and `agent.tokens` metrics `@driftwatch/sdk` emits.

## Import it

1. In SigNoz, go to **Dashboards → New dashboard → Import JSON**.
2. Upload `signoz-dashboard.json` (or paste its contents).
3. Generate some traffic against a DriftWatch server first if the panels look
   empty — see [docs/signoz.md](../docs/signoz.md#verify-its-flowing).

No dashboard variables are set up (kept intentionally simple for a
single-service deployment); if you run multiple DriftWatch-like services
against the same SigNoz instance, add a `service.name` filter to each panel's
query.
