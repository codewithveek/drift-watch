/**
 * Compile-time types for authoring tool-call policies.
 *
 * These are an AUTHORING overlay on `ToolCallPolicyRule` (../autopilot/
 * tool-call-policy.ts), not a replacement for it. Rules also arrive as JSON from
 * the console and the database, so the zod schema remains the runtime source of
 * truth and is still enforced on every path — "the types already checked it" is
 * exactly the reasoning that turns a validation layer into a security hole.
 * `toRuntimeRule` below is the one-way door from this world to that one.
 *
 * ## What each field gets, and why they differ
 *
 * - **`tool` is STRICT** when tools are declared locally. A rule naming a tool
 *   that does not exist is a silently dead security rule — the exact failure
 *   that declaring tools inside the agent was meant to make impossible — so
 *   `'issue_refnud'` must be a compile error, not a shrug.
 * - **`field` is LOOSE** (`| (string & {})`). Path extraction is depth-limited
 *   (see `Paths` below), so a legitimately deeper path would otherwise be
 *   rejected by a limitation of the type machinery rather than by anything
 *   actually wrong. A wrong path fails open into "field absent", which is
 *   visible at runtime; a wrong tool name fails silent.
 * - **Comparison operators are restricted to numeric fields.** The runtime
 *   coerces `gt`/`gte`/`lt`/`lte` operands with `Number()`, so `{ gt: 5 }` on a
 *   string field compares against `NaN` and can never match. That is a rule
 *   that looks enforced and enforces nothing, which is worth a compile error.
 */
import type { InferToolInput, ToolSet } from 'ai';
import type { DriftSeverity } from '../autopilot/types.js';
import type { ToolCallPolicyRule } from '../autopilot/tool-call-policy.js';

/**
 * Countdown used to bound `Paths` recursion.
 *
 * Without a bound, a self-referential schema recurses until TypeScript's
 * instantiation-depth limit and errors; worse, a wide-but-legal schema can make
 * `tsc` crawl. Three levels covers `customer.address.country`, which is deeper
 * than any realistic tool input, and the escape hatch for the rest is that
 * `field` accepts a plain string anyway.
 */
type DepthCountdown = [never, 0, 1, 2, 3];

/** Dot-paths into an object type, to a bounded depth. */
export type Paths<T, Depth extends number = 3> = [Depth] extends [never]
  ? never
  : // Arrays are excluded deliberately: `items.0.sku` is not a stable policy
    // target, and mapping over an array type would enumerate every numeric key
    // plus the whole Array prototype.
    T extends readonly unknown[]
    ? never
    : T extends object
      ? {
          [K in keyof T & string]:
            | K
            | (NonNullable<T[K]> extends object
                ? `${K}.${Paths<NonNullable<T[K]>, DepthCountdown[Depth]>}`
                : never);
        }[keyof T & string]
      : never;

/** The type sitting at a dot-path, or `unknown` when the path does not resolve. */
export type ValueAtPath<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? ValueAtPath<NonNullable<T[Head]>, Rest>
    : unknown
  : P extends keyof T
    ? T[P]
    : unknown;

/**
 * A tool's inferred input type.
 *
 * Uses the AI SDK's own `InferToolInput` rather than a hand-written
 * `Tool<infer Input, ...>` match. The latter compiles but silently resolves to
 * `unknown` — `Tool`'s generics carry more parameters than the two visible ones,
 * so the pattern never matches — and every condition then degrades to "any
 * operator allowed" with no error to explain why.
 */
export type InputOf<TTools extends ToolSet, Name extends keyof TTools> = InferToolInput<
  TTools[Name]
>;

/**
 * Tool names available to a rule.
 *
 * `[keyof T] extends [never]` — bracketed so it does not distribute over the
 * union — detects "no tools declared" and falls back to `string`. Without that,
 * an agent declaring no tools would get `never` and every rule would fail to
 * compile. `'*'` is always allowed: it is the runtime's match-everything token.
 */
export type ToolName<TTools extends ToolSet> = [keyof TTools] extends [never]
  ? string
  : (keyof TTools & string) | '*';

/**
 * A field path for one tool: suggested from its input schema, but not enforced.
 * `(string & {})` is structurally `string`, and TypeScript does not collapse the
 * union — which is what preserves the suggestions while still accepting anything.
 */
export type FieldPath<TInput> = Paths<TInput> | (string & {});

/**
 * Match conditions, narrowed by the field's own type.
 *
 * The comparison operators are present only when the field is numeric, so
 * autocomplete on a string field offers `equals` and `exists` and nothing that
 * would silently never fire.
 */
export type Condition<Value> = {
  equals?: NonNullable<Value> extends never ? never : NonNullable<Value>;
  /** Fire whenever the field is present, whatever its value. */
  exists?: boolean;
} & (NonNullable<Value> extends number
  ? { gt?: number; gte?: number; lt?: number; lte?: number }
  : // eslint-disable-next-line @typescript-eslint/ban-types
    {});

interface RuleBase {
  action: 'deny' | 'require_approval';
  /**
   * Drives notification treatment. Optional here and required on the wire —
   * `toRuntimeRule` fills in 'medium', because being made to state a severity
   * before you can gate a tool call is friction with no decision behind it.
   */
  severity?: DriftSeverity;
  /** Shown to whoever is asked to approve. Worth writing: it is the whole context they get. */
  reason?: string;
}

/**
 * One rule, with `field` and `condition` correlated to the named tool.
 *
 * The union is built by distributing over tool names and then over each tool's
 * own paths, which is what lets `condition` know the type of the field selected
 * by `field`. Union size is (paths + 1) summed across tools — tens of members
 * for a realistic agent, which TypeScript handles comfortably.
 */
export type PolicyRule<TTools extends ToolSet> = {
  [Name in ToolName<TTools>]:
    | (RuleBase & {
        tool: Name;
        /** Omitted: gate every call to this tool regardless of its arguments. */
        field?: undefined;
        condition?: undefined;
      })
    | {
        [P in FieldPath<Name extends keyof TTools ? InputOf<TTools, Name> : unknown>]: RuleBase & {
          tool: Name;
          field: P;
          condition?: Condition<
            ValueAtPath<Name extends keyof TTools ? InputOf<TTools, Name> : unknown, P>
          >;
        };
      }[FieldPath<Name extends keyof TTools ? InputOf<TTools, Name> : unknown>];
}[ToolName<TTools>];

/** Severity when the author did not state one. */
const DEFAULT_SEVERITY: DriftSeverity = 'medium';

/**
 * Narrows an authored rule to the wire/runtime shape.
 *
 * The authoring types are strictly narrower than `ToolCallPolicyRule`, so this
 * is a widening and cannot fail — but it is a real function rather than a cast
 * so the severity default lives in exactly one place, and so a future divergence
 * between the two shapes surfaces here as a type error instead of at runtime.
 */
export function toRuntimeRule<TTools extends ToolSet>(rule: PolicyRule<TTools>): ToolCallPolicyRule {
  const authored = rule as RuleBase & {
    tool: string;
    field?: string;
    condition?: Record<string, unknown>;
  };
  return {
    tool: authored.tool,
    ...(authored.field === undefined ? {} : { field: authored.field }),
    ...(authored.condition === undefined
      ? {}
      : { condition: authored.condition as ToolCallPolicyRule['condition'] }),
    action: authored.action,
    severity: authored.severity ?? DEFAULT_SEVERITY,
    ...(authored.reason === undefined ? {} : { reason: authored.reason }),
  };
}
