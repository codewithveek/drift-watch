import { useState } from 'react';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { ToolCallPolicyRule, ToolMetadata } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/domain';

/** The comparison operators a rule's `condition` supports, plus "no condition". */
const OPERATORS = [
  { value: 'any', label: 'is present' },
  { value: 'equals', label: '=' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'exists', label: 'exists' },
] as const;

type Operator = (typeof OPERATORS)[number]['value'];

const SEVERITIES = ['none', 'low', 'medium', 'high'] as const;

/** Renders a rule's condition the way it reads in the policy, e.g. `amountUsd > 100`. */
function describeCondition(rule: ToolCallPolicyRule): string | null {
  if (!rule.field) return null;
  const entries = Object.entries(rule.condition ?? {});
  if (entries.length === 0) return `${rule.field} is present`;
  const [op, value] = entries[0];
  const label = OPERATORS.find((o) => o.value === op)?.label ?? op;
  return op === 'exists' ? `${rule.field} ${value ? 'exists' : 'is absent'}` : `${rule.field} ${label} ${value}`;
}

function newRule(tool: string): ToolCallPolicyRule {
  return { tool, action: 'require_approval', severity: 'medium' };
}

/**
 * Turns the operand text box into the typed value the rule schema expects.
 * `amountUsd > 100` must compare numerically, but `role equals admin` must
 * stay a string — so coerce only when the input really is numeric.
 */
export function coerceOperand(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const asNumber = Number(trimmed);
  return trimmed !== '' && !Number.isNaN(asNumber) ? asNumber : raw;
}

/**
 * Authoring UI for a single agent's tool-call policies.
 *
 * State is owned here and lifted to the parent on every change — the parent
 * saves the whole array, because `toolPolicies` is a full replace on PATCH
 * (a rule list composes by "which rules apply", so there is no per-field merge
 * to do). It is initialized once from loader data and never useEffect-synced,
 * which would clobber edits in progress on the next poll.
 */
export function PolicyEditor({
  rules,
  tools,
  onChange,
}: {
  rules: ToolCallPolicyRule[];
  tools: ToolMetadata[];
  onChange: (next: ToolCallPolicyRule[]) => void;
}) {
  const [draft, setDraft] = useState<ToolCallPolicyRule | null>(null);
  const [operator, setOperator] = useState<Operator>('any');
  const [operand, setOperand] = useState('');

  const draftTool = tools.find((tool) => tool.name === draft?.tool);
  const availableFields = draftTool?.fields ?? [];

  function commitDraft() {
    if (!draft) return;
    const rule: ToolCallPolicyRule = { ...draft };

    if (rule.field && operator !== 'any') {
      if (operator === 'exists') {
        rule.condition = { exists: true };
      } else if (operand.trim() !== '') {
        rule.condition = { [operator]: coerceOperand(operand) };
      }
    }
    // A rule with no field gates the whole tool; a stray condition there would
    // never be evaluated, so don't persist one.
    if (!rule.field) delete rule.condition;

    onChange([...rules, rule]);
    setDraft(null);
    setOperator('any');
    setOperand('');
  }

  return (
    <div className="space-y-3">
      {rules.length === 0 && !draft ? (
        <EmptyState icon={<ShieldCheck className="size-6" />} title="No tool-call policies">
          Every tool this agent can reach runs unchecked. Add a rule to gate one — for example,
          requiring approval when a refund exceeds a threshold.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rules.map((rule, index) => {
            const condition = describeCondition(rule);
            return (
              <li key={index} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                <code className="font-mono font-medium text-ink">{rule.tool}</code>
                {condition && (
                  <code className="font-mono text-2xs text-ink-3">{condition}</code>
                )}
                <span
                  className={
                    rule.action === 'deny'
                      ? 'rounded-full bg-danger/15 px-2 py-0.5 text-2xs font-medium text-danger-text'
                      : 'rounded-full bg-warn/12 px-2 py-0.5 text-2xs font-medium text-warn-text'
                  }
                >
                  {rule.action === 'deny' ? 'deny' : 'require approval'}
                </span>
                {rule.reason && <span className="text-xs text-ink-3">{rule.reason}</span>}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  aria-label={`Remove rule for ${rule.tool}`}
                  onClick={() => onChange(rules.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {draft ? (
        <div className="space-y-3 rounded-lg border border-line bg-panel-2/40 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Tool</Label>
              <Select
                value={draft.tool}
                onValueChange={(tool) => setDraft({ ...draft, tool, field: undefined })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="*">* (any tool)</SelectItem>
                  {tools.map((tool) => (
                    <SelectItem key={tool.name} value={tool.name}>
                      {tool.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label>Action</Label>
              <Select
                value={draft.action}
                onValueChange={(action) =>
                  setDraft({ ...draft, action: action as ToolCallPolicyRule['action'] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="require_approval">Require approval</SelectItem>
                  <SelectItem value="deny">Deny outright</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>Field (optional)</Label>
              <Select
                value={draft.field ?? '__none'}
                onValueChange={(field) =>
                  setDraft({ ...draft, field: field === '__none' ? undefined : field })
                }
                disabled={draft.tool === '*' || availableFields.length === 0}
              >
                <SelectTrigger>
                  <SelectValue placeholder="whole tool" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">whole tool</SelectItem>
                  {availableFields.map((field) => (
                    <SelectItem key={field} value={field}>
                      {field}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label>Condition</Label>
              <Select
                value={operator}
                onValueChange={(value) => setOperator(value as Operator)}
                disabled={!draft.field}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPERATORS.map((op) => (
                    <SelectItem key={op.value} value={op.value}>
                      {op.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label>Value</Label>
              <Input
                value={operand}
                disabled={!draft.field || operator === 'any' || operator === 'exists'}
                placeholder="100"
                onChange={(event) => setOperand(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Severity</Label>
              <Select
                value={draft.severity}
                onValueChange={(severity) =>
                  setDraft({ ...draft, severity: severity as ToolCallPolicyRule['severity'] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((severity) => (
                    <SelectItem key={severity} value={severity}>
                      {severity}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Reason (optional)</Label>
              <Input
                value={draft.reason ?? ''}
                placeholder="shown to whoever approves"
                onChange={(event) => setDraft({ ...draft, reason: event.target.value || undefined })}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={commitDraft}>
              Add rule
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDraft(newRule(tools[0]?.name ?? '*'))}
        >
          <Plus className="size-3.5" />
          Add rule
        </Button>
      )}
    </div>
  );
}
