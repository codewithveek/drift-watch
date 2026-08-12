/**
 * Demo skills (AI SDK tools) for this reference server. These are NOT part
 * of @driftwatch/sdk — the SDK's runAgentTask takes `tools` as a parameter
 * precisely so real deployments bring their own (DB lookups, HTTP calls,
 * vector search, ...). This file shows the pattern: each tool's `execute` is
 * wrapped by `runtime.skill(name, fn)`, which supplies the SDK's labelled
 * tool-call counter + latency histogram AND the pre-execution policy gate.
 *
 * Each entry is a FACTORY (runtime) => Tool, not a built Tool — a Tool's
 * `execute` closure is already constructed by the time a flat registry object
 * exists, so there's no way to inject per-call agent context into an
 * already-built Tool from outside. Building fresh per request (cheap — no
 * I/O, just object construction) is what lets the span and the policy gate
 * see which agent is calling.
 *
 * Note the split of responsibilities: the SDK owns "wrap ONE tool with this
 * agent's context" (`runtime.skill`), while filtering a shared catalogue down
 * to the subset one agent may call stays here, because a registry of named
 * tools is this server's concern — a typical SDK consumer just writes their
 * tools inline and has nothing to filter.
 */
import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AgentRuntime } from '@driftwatch/sdk';

function simulateLatency(minimumMs: number, maximumMs: number): Promise<void> {
  const delayMs = minimumMs + Math.random() * (maximumMs - minimumMs);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Describes a tool to anything authoring policy against it — principally the
 * console's policy editor, which needs to know which fields exist before it
 * can offer a rule that matches on one.
 *
 * The three boolean hints deliberately mirror MCP's tool-annotation
 * vocabulary (`readOnlyHint`/`destructiveHint`/`idempotentHint`) so the naming
 * is familiar and portable. `sensitiveFields` has no MCP equivalent yet — MCP
 * annotates whole tools, not fields — but field-level is exactly the
 * granularity tool-call policies work at, so it's a DriftWatch addition.
 *
 * These are DESCRIPTIVE ONLY. Nothing gates a call because a tool is marked
 * destructive; gating happens solely through explicit policy rules, so that
 * adding metadata can never silently change an agent's behaviour.
 */
export interface ToolMetadata {
  name: string;
  description: string;
  /** Dot-paths a policy rule's `field` can match on. Derived from the schema. */
  fields: string[];
  /** Does not modify state. */
  readOnly: boolean;
  /** May destroy or overwrite rather than only add. Meaningless when readOnly. */
  destructive: boolean;
  /** Repeating the call is equivalent to making it once. */
  idempotent: boolean;
  /**
   * Fields whose VALUES shouldn't be echoed into an approval notification.
   * Advisory metadata for policy authors; payload capture itself is governed
   * by OTEL_CAPTURE_PAYLOADS.
   */
  sensitiveFields?: string[];
}

interface ToolEntry {
  meta: Omit<ToolMetadata, 'fields'> & { fields?: string[] };
  /** Kept alongside the factory so `fields` can be derived rather than hand-listed. */
  inputSchema: z.ZodObject<z.ZodRawShape>;
  create: (runtime: AgentRuntime) => Tool;
}

const weatherInput = z.object({
  city: z.string().describe('City name'),
});

const searchInput = z.object({
  query: z.string().describe('Search query'),
});

const toolEntries: Record<string, ToolEntry> = {
  get_weather: {
    inputSchema: weatherInput,
    meta: {
      name: 'get_weather',
      description: 'Get current weather for a city',
      readOnly: true,
      destructive: false,
      idempotent: true,
    },
    create: (runtime) =>
      tool({
        description: 'Get current weather for a city',
        inputSchema: weatherInput,
        execute: runtime.skill('get_weather', async (input: { city: string }) => {
          // simulate variable latency so drift detection has signal to chew on
          await simulateLatency(50, 250);
          return { city: input.city, tempC: 20 + Math.round(Math.random() * 10) };
        }),
      }),
  },

  search_docs: {
    inputSchema: searchInput,
    meta: {
      name: 'search_docs',
      description: 'Search internal documentation for a query',
      readOnly: true,
      destructive: false,
      idempotent: true,
    },
    create: (runtime) =>
      tool({
        description: 'Search internal documentation for a query',
        inputSchema: searchInput,
        execute: runtime.skill('search_docs', async (input: { query: string }) => {
          await simulateLatency(30, 150);
          return { query: input.query, hits: Math.floor(Math.random() * 5) };
        }),
      }),
  },
};

/** Every tool name this server knows about — the validation set for agent registration/edit. */
export const allToolNames = Object.keys(toolEntries);

/**
 * Full descriptions for policy authoring. `fields` is read off each Zod schema
 * rather than duplicated by hand, so a schema change can't leave the metadata
 * quietly describing fields that no longer exist.
 */
export const allToolMetadata: ToolMetadata[] = Object.values(toolEntries).map((entry) => ({
  ...entry.meta,
  fields: entry.meta.fields ?? Object.keys(entry.inputSchema.shape),
}));

/**
 * Builds the ToolSet for one agent's run: `toolNames` filters which tools it
 * gets (omit = every registered tool, today's pre-fleet behavior); each tool
 * is constructed fresh against the supplied runtime, so its execute() carries
 * that agent's identity and tool-call policies.
 */
export function buildAgentTools(options: {
  runtime: AgentRuntime;
  toolNames?: string[];
}): ToolSet {
  const { runtime, toolNames } = options;
  const selected = toolNames ?? allToolNames;
  const result: ToolSet = {};
  for (const name of selected) {
    const entry = toolEntries[name];
    if (entry) result[name] = entry.create(runtime);
  }
  return result;
}
