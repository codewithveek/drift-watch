/**
 * Skills (AI SDK tools): each is a `tool()` with a Zod input schema and an
 * `execute` fn. We wrap `execute` with withSkillExecutionSpan so every call
 * still emits our custom tool-call counter + latency histogram (the AI SDK's
 * own telemetry traces the call, but doesn't emit these labelled metrics).
 *
 * Swap these bodies for real logic (DB, HTTP, vector search). The pattern —
 * tool() wrapping withSkillExecutionSpan — stays identical.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { withSkillExecutionSpan } from '../telemetry/instrument.js';

function simulateLatency(minimumMs: number, maximumMs: number): Promise<void> {
  const delayMs = minimumMs + Math.random() * (maximumMs - minimumMs);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export const tools = {
  get_weather: tool({
    description: 'Get current weather for a city',
    inputSchema: z.object({
      city: z.string().describe('City name'),
    }),
    execute: (skillInput) =>
      withSkillExecutionSpan({
        skillName: 'get_weather',
        skillInput,
        executeSkill: async () => {
          // simulate variable latency so drift detection has signal to chew on
          await simulateLatency(50, 250);
          return {
            city: skillInput.city,
            tempC: 20 + Math.round(Math.random() * 10),
          };
        },
      }),
  }),

  search_docs: tool({
    description: 'Search internal documentation for a query',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
    }),
    execute: (skillInput) =>
      withSkillExecutionSpan({
        skillName: 'search_docs',
        skillInput,
        executeSkill: async () => {
          await simulateLatency(30, 150);
          return {
            query: skillInput.query,
            hits: Math.floor(Math.random() * 5),
          };
        },
      }),
  }),
};
