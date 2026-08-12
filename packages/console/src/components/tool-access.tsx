import { Lock, ShieldOff, Wrench } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/domain';
import { describeCondition, gateFor, GATE_LABEL } from '@/lib/policy';
import { cn } from '@/lib/utils';
import type { ToolCallPolicyRule, ToolMetadata } from '@/api';

/**
 * What this agent can actually reach.
 *
 * The question an operator asks about a gated tool call is never just "what
 * did it try to do" — it is "what else can this thing do". That answer is
 * spread across three places in the API (the allow-list, the resolved policy
 * set, and the tool registry's own metadata), so it gets one card that joins
 * them.
 *
 * Ordering is by consequence, not alphabet: denied first, then gated, then the
 * rest. A tool that runs unchecked is the least interesting row here, and an
 * alphabetical list would bury the two that matter.
 */
export function ToolAccessCard({
  toolNames,
  toolPolicies,
  allTools,
  className,
  limit = 8,
}: {
  /** The agent's resolved allow-list. */
  toolNames: string[];
  /** The agent's resolved rule set, including inherited rules. */
  toolPolicies: ToolCallPolicyRule[];
  /** Every tool registered on the server, for metadata. */
  allTools: ToolMetadata[];
  className?: string;
  limit?: number;
}) {
  const metadata = new Map(allTools.map((tool) => [tool.name, tool]));

  const rows = toolNames
    .map((name) => ({ name, meta: metadata.get(name), gate: gateFor(name, toolPolicies) }))
    .sort((a, b) => rank(b) - rank(a));

  const gatedCount = rows.filter((row) => row.gate.action !== null).length;
  const shown = rows.slice(0, limit);

  return (
    <Card className={cn('gap-4', className)}>
      <CardHeader className="gap-1">
        <CardTitle className="text-base">Tool access</CardTitle>
        <p className="text-xs text-ink-3">
          {allTools.length > 0 ? (
            <>
              Can call <span className="tabular-nums">{toolNames.length}</span> of{' '}
              <span className="tabular-nums">{allTools.length}</span> registered tools
              {gatedCount > 0 ? (
                <>
                  ; <span className="tabular-nums">{gatedCount}</span> gated by policy.
                </>
              ) : (
                '. None are gated — every call runs unchecked.'
              )}
            </>
          ) : (
            'No tools are registered on this server yet.'
          )}
        </p>
      </CardHeader>

      <CardContent className="px-0">
        {shown.length === 0 ? (
          <EmptyState icon={<Wrench className="size-5" />} title="No tools reachable">
            This agent's allow-list is empty, so every tool call it attempts is refused before any
            policy is consulted.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {shown.map(({ name, meta, gate }) => (
              <li key={name} className="flex items-start gap-3 px-6 py-2.5">
                <span
                  className={cn(
                    'mt-0.5 grid size-6 shrink-0 place-items-center rounded-md',
                    gate.action === 'deny'
                      ? 'bg-danger/15 text-danger-text'
                      : gate.action === 'require_approval'
                        ? 'bg-warn/15 text-warn-text'
                        : 'bg-panel-2 text-ink-3',
                  )}
                >
                  {gate.action === 'deny' ? (
                    <ShieldOff className="size-3.5" />
                  ) : gate.action === 'require_approval' ? (
                    <Lock className="size-3.5" />
                  ) : (
                    <Wrench className="size-3.5" />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <code className="font-mono text-xs font-medium text-ink">{name}</code>
                    {gate.action && (
                      <Badge
                        className={cn(
                          'border-transparent font-medium',
                          gate.action === 'deny'
                            ? 'bg-danger/15 text-danger-text'
                            : 'bg-warn/15 text-warn-text',
                        )}
                      >
                        {GATE_LABEL[gate.action]}
                      </Badge>
                    )}
                    {meta?.destructive && (
                      <Badge className="border-transparent bg-panel-2 font-medium text-ink-3">
                        destructive
                      </Badge>
                    )}
                  </div>

                  {gate.rules.length > 0 && (
                    <p className="mt-0.5 truncate font-mono text-2xs text-ink-3">
                      {gate.rules
                        .map((rule) => describeCondition(rule) ?? `any call to ${rule.tool}`)
                        .join(' · ')}
                    </p>
                  )}

                  {meta?.sensitiveFields && meta.sensitiveFields.length > 0 && (
                    <p className="mt-0.5 text-2xs text-ink-3">
                      touches{' '}
                      <span className="font-mono text-ink-2">
                        {meta.sensitiveFields.join(', ')}
                      </span>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {rows.length > shown.length && (
          <p className="border-t border-line px-6 pt-2.5 text-2xs text-ink-3">
            + {rows.length - shown.length} more, all ungated. The full list is on the Config tab.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Denied outranks gated outranks plain; `destructive` breaks ties. */
function rank(row: { meta?: ToolMetadata; gate: { action: string | null } }): number {
  if (row.gate.action === 'deny') return 3;
  if (row.gate.action === 'require_approval') return 2;
  return row.meta?.destructive ? 1 : 0;
}
