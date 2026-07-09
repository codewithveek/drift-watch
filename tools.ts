/**
 * Tools in AI SDK format: each is a `tool()` with a Zod input schema and an
 * `execute` fn. We keep the withToolSpan wrapper inside execute so every call
 * still emits our custom tool-call counter + latency histogram (the AI SDK's
 * own telemetry traces the call, but doesn't emit these labelled metrics).
 *
 * Swap these bodies for real logic (DB, HTTP, vector search). The pattern —
 * tool() wrapping withToolSpan — stays identical.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { withToolSpan } from '../telemetry/instrument.js';

export const tools = {
  get_weather: tool({
    description: 'Get current weather for a city',
    inputSchema: z.object({
      city: z.string().describe('City name'),
    }),
    execute: (input) =>
      withToolSpan('get_weather', input, async () => {
        // simulate variable latency so drift detection has signal to chew on
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
        return { city: input.city, tempC: 20 + Math.round(Math.random() * 10) };
      }),
  }),

  search_docs: tool({
    description: 'Search internal documentation for a query',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
    }),
    execute: (input) =>
      withToolSpan('search_docs', input, async () => {
        await new Promise((r) => setTimeout(r, 30 + Math.random() * 120));
        return { query: input.query, hits: Math.floor(Math.random() * 5) };
      }),
  }),
};
