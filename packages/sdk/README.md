# @agentpulse/sdk

Self-observing AI agent SDK: OpenTelemetry instrumentation for
[AI SDK](https://ai-sdk.dev) agents, plus an LLM-over-traces behavioral
drift detector. Zero AI provider SDKs bundled, zero direct `process.env`
access — every function takes typed config/clients as parameters.

> **Naming note:** `@agentpulse/sdk` is a working name, not a final
> published identity — `agentpulse` is already taken on npm under a
> different project. See the [workspace README](../../README.md#naming).

## Install

```bash
npm install @agentpulse/sdk ai zod
# plus whichever AI SDK provider package you want, e.g.:
npm install @ai-sdk/anthropic
```

## Quickstart

```ts
import {
  runAgentTask,
  detectBehavioralDrift,
  bootstrapTelemetry,
  loadAgentPulseConfigFromEnv,
} from '@agentpulse/sdk';
import { anthropic } from '@ai-sdk/anthropic';
import { tool } from 'ai';
import { z } from 'zod';

const config = loadAgentPulseConfigFromEnv();
bootstrapTelemetry(config.telemetry); // call before other imports run, e.g. via --import

const modelClient = anthropic('claude-3-5-sonnet-latest');
const tools = {
  lookup_order: tool({
    description: 'Look up an order by id',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => ({ orderId, status: 'shipped' }),
  }),
};

const result = await runAgentTask({
  prompt: 'Where is order 4471?',
  modelClient,
  tools,
  maxSteps: config.agent.maxSteps,
});
console.log(result.responseText, result.tokenUsage);

const driftReport = await detectBehavioralDrift({
  modelClient,
  driftDetectionConfig: config.driftDetection,
});
```

## What's in this package

- `runAgentTask` — a traced `generateText` tool-use loop. Takes
  `modelClient` and `tools` as parameters; returns task id, skills used,
  and token usage.
- `detectBehavioralDrift` — queries two time windows from a SigNoz-shaped
  backend, diffs them, and asks an LLM (`generateObject`) to classify
  drift. Supports `isDryRun: true` for fixture-based demos/CI.
- `bootstrapTelemetry` — starts the OTel Node SDK and registers the AI SDK
  v7 telemetry bridge. Call once, before other application code (typically
  via `node --import`).
- `withSkillExecutionSpan` — wrap a tool's `execute` so every call emits a
  labelled span + the `agent.tool.calls` / `agent.tool.duration` metrics.
- `AgentPulseConfigSchema` / `loadAgentPulseConfigFromEnv` — Zod-validated
  typed config for telemetry, agent, and drift-detection settings.

Full docs, architecture, and the reference Fastify server that uses this
SDK live in the [workspace repo](https://github.com/codewithveek/drift-watch) —
see [`docs/`](https://github.com/codewithveek/drift-watch/tree/main/docs)
for guides and the [root README](https://github.com/codewithveek/drift-watch#readme)
for the full picture.

## License

MIT — see [LICENSE](https://github.com/codewithveek/drift-watch/blob/main/LICENSE).
