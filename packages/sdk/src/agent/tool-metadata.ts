/**
 * Describes an agent's tools for the control plane.
 *
 * This is what makes field-scoped policy authoring possible in the console. A
 * rule like `{ tool: 'issue_refund', field: 'amountUsd', condition: { gt: 100 } }`
 * needs someone to know that `issue_refund` has a numeric `amountUsd` — the SDK
 * knows because it holds the schema, and the console cannot know unless it is
 * told. So the same information that gives compile-time autocomplete locally
 * (see policy-authoring.ts) is shipped at sync time to drive the dropdowns
 * remotely: one source, two surfaces.
 *
 * Extraction is best-effort by design. The AI SDK accepts Zod schemas, JSON
 * Schema, and custom validators, and a tool whose fields cannot be read is a
 * tool the console shows without field suggestions — mildly worse authoring,
 * never a failure. Registration must not break because a schema had an
 * unfamiliar shape.
 */
import type { ToolSet } from 'ai';

/**
 * A tool as the control plane sees it. Mirrors the server's own `ToolMetadata`.
 *
 * Every hint here is DESCRIPTIVE. Nothing is gated because a tool is marked
 * destructive — gating comes solely from explicit policy rules, and conflating
 * the two would mean an annotation silently changed enforcement.
 */
export interface SyncedToolMetadata {
  name: string;
  description: string;
  /** Dot-paths a policy rule may target. Empty when the schema was unreadable. */
  fields: string[];
  /** MCP-aligned annotations, carried through for display. */
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

/** Depth cap, matching `Paths` in policy-authoring.ts so both surfaces agree. */
const MAX_FIELD_DEPTH = 3;

export function describeTools(tools: ToolSet): SyncedToolMetadata[] {
  return Object.entries(tools).map(([name, tool]) => {
    const definition = tool as {
      description?: string;
      inputSchema?: unknown;
      readOnly?: boolean;
      destructive?: boolean;
      idempotent?: boolean;
    };
    return {
      name,
      description: definition.description ?? '',
      fields: extractFieldPaths(definition.inputSchema),
      ...(definition.readOnly !== undefined ? { readOnly: definition.readOnly } : {}),
      ...(definition.destructive !== undefined ? { destructive: definition.destructive } : {}),
      ...(definition.idempotent !== undefined ? { idempotent: definition.idempotent } : {}),
    };
  });
}

/**
 * Dot-paths from a tool's input schema.
 *
 * Handles the two shapes that actually occur: a Zod object (`.shape`) and JSON
 * Schema (`.properties`). Anything else yields no paths rather than throwing —
 * see the module docblock on why this must degrade rather than fail.
 */
export function extractFieldPaths(schema: unknown, depth = 0): string[] {
  if (!schema || typeof schema !== 'object' || depth >= MAX_FIELD_DEPTH) return [];

  const shape = zodShapeOf(schema) ?? jsonSchemaPropertiesOf(schema);
  if (!shape) return [];

  const paths: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    paths.push(key);
    for (const nested of extractFieldPaths(child, depth + 1)) {
      paths.push(`${key}.${nested}`);
    }
  }
  return paths;
}

/**
 * A Zod object's `shape`, unwrapping the wrappers that hide it.
 *
 * `.optional()`, `.nullable()` and `.default()` each return a NEW schema whose
 * inner type holds the shape, so an optional nested object would otherwise
 * contribute no field paths at all — and optional fields are precisely the ones
 * policies tend to target.
 */
function zodShapeOf(schema: object): Record<string, unknown> | undefined {
  const candidate = schema as {
    shape?: unknown;
    _def?: { shape?: unknown; innerType?: unknown; typeName?: string };
    unwrap?: () => unknown;
  };

  const shape = candidate.shape ?? candidate._def?.shape;
  if (shape) {
    // zod 3 exposes `shape` as a getter on some versions and a thunk on others.
    const resolved = typeof shape === 'function' ? (shape as () => unknown)() : shape;
    if (resolved && typeof resolved === 'object') return resolved as Record<string, unknown>;
  }

  const inner = candidate._def?.innerType;
  if (inner && typeof inner === 'object') return zodShapeOf(inner as object);
  return undefined;
}

/** JSON Schema's `properties`, for tools defined with `jsonSchema()`. */
function jsonSchemaPropertiesOf(schema: object): Record<string, unknown> | undefined {
  const candidate = schema as { properties?: unknown; jsonSchema?: { properties?: unknown } };
  const properties = candidate.properties ?? candidate.jsonSchema?.properties;
  return properties && typeof properties === 'object'
    ? (properties as Record<string, unknown>)
    : undefined;
}
