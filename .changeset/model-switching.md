---
"@driftwatch/sdk": minor
---

Autopilot model switching — turn the `switch_model` control action into a real
remediation that reroutes the agent to a different model, with drift-aware
false-positive handling.

- **`switch_model` now reroutes.** Previously the action only updated an
  `activeModel` label; nothing read it. `ApprovalService` gains a `switchModelTo`
  option so an approved `switch_model` sets the agent's active model to a real
  target. The reference server routes each `/run` to that model via a model
  registry (`model-client.ts`), falling back to the primary otherwise. The
  headline use case: downshift to a cheaper model when SigNoz shows token spend
  spiking, and watch spend drop in the same dashboard.
- **Switch marker telemetry.** Executing a `switch_model` now emits an
  `agent.model.switch` span (visible on the trace timeline, and explainable via
  SigNoz MCP) plus an `agent.model.switches` counter (labelled by from/to
  model).
- **The cure no longer looks like the disease.** `detectBehavioralDrift` queries
  the `agent.model.switches` counter for the current window and, when a switch
  occurred, tells the judge that the resulting change is intentional — so an
  approved downshift is not itself flagged as drift, while a genuine regression
  that coincides with a switch still is. The query is fail-safe: any error
  resolves to "no switch," so it never breaks detection.

The drift judge always runs on the primary model, so switching the agent's model
never weakens detection.
