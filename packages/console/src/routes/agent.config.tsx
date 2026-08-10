import { useState } from 'react';
import { useParams, useRevalidator, useRouteLoaderData } from 'react-router';
import { Save, ShieldCheck } from 'lucide-react';
import { client, type AgentConfig, type ToolCallPolicyRule } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/domain';
import type { AgentLoaderData } from './agent';

export interface ConfigLoaderData {
  allTools: string[];
}

export async function configLoader(): Promise<ConfigLoaderData> {
  const { tools } = await client.getTools();
  return { allTools: tools };
}

/** The guardrail fields that are plain numbers, in display order. */
const NUMERIC_GUARDRAILS: { key: keyof AgentConfig; label: string; hint: string }[] = [
  { key: 'maxSteps', label: 'Max steps', hint: 'tool-use loop bound' },
  { key: 'maxTokensPerTask', label: 'Max tokens / task', hint: '0 disables' },
  { key: 'maxCostUsd', label: 'Max cost (USD)', hint: '0 disables' },
  { key: 'pricePer1kInput', label: 'Price / 1k input', hint: 'used to derive cost' },
  { key: 'pricePer1kOutput', label: 'Price / 1k output', hint: 'used to derive cost' },
];

export function AgentConfigPage() {
  const { agentId } = useParams();
  const { definition, state } = useRouteLoaderData('agent') as AgentLoaderData;
  const { allTools } = useRouteLoaderData('agent-config') as ConfigLoaderData;
  const revalidator = useRevalidator();

  // Initialized once from loader data — deliberately NOT synced via useEffect,
  // which would clobber whatever the operator is typing on the next poll.
  const [guardrails, setGuardrails] = useState<Partial<AgentConfig>>(
    () => definition.guardrails ?? {},
  );
  const [toolNames, setToolNames] = useState<string[]>(
    () => definition.toolNames ?? allTools,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const policies: ToolCallPolicyRule[] = state.toolPolicies ?? [];

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await client.updateAgent(agentId!, { guardrails, toolNames });
      setSaved(true);
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md bg-danger/12 px-3 py-2 text-sm text-danger-text" role="alert">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="rounded-md bg-ok/12 px-3 py-2 text-sm text-ok-text" role="status">
          Saved. This applies to the agent's next run — no restart needed.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Guardrails</CardTitle>
          <CardDescription>
            Per-agent overrides. Anything left blank inherits the deployment default
            {definition.guardrailsSource && (
              <>
                {' '}
                by way of <code className="font-mono text-2xs">{definition.guardrailsSource}</code>
              </>
            )}
            . Effective values are shown as placeholders.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {NUMERIC_GUARDRAILS.map(({ key, label, hint }) => (
              <div key={key} className="grid gap-1.5">
                <Label htmlFor={key}>{label}</Label>
                <Input
                  id={key}
                  type="number"
                  min={0}
                  inputMode="decimal"
                  placeholder={String(state.guardrails[key] ?? 0)}
                  value={guardrails[key] === undefined ? '' : String(guardrails[key])}
                  onChange={(event) => {
                    const raw = event.target.value;
                    setSaved(false);
                    setGuardrails((current) => {
                      const next = { ...current };
                      if (raw === '') delete next[key];
                      else next[key] = Number(raw) as never;
                      return next;
                    });
                  }}
                />
                <p className="text-2xs text-ink-3">{hint}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tools</CardTitle>
          <CardDescription>
            Which of the server's registered tools this agent may call.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {allTools.map((tool) => {
              const enabled = toolNames.includes(tool);
              return (
                <button
                  key={tool}
                  type="button"
                  aria-pressed={enabled}
                  onClick={() => {
                    setSaved(false);
                    setToolNames((current) =>
                      current.includes(tool)
                        ? current.filter((name) => name !== tool)
                        : [...current, tool],
                    );
                  }}
                  className={
                    enabled
                      ? 'rounded-full bg-brand px-3 py-1 font-mono text-xs font-medium text-primary-foreground transition-colors hover:bg-brand-hover'
                      : 'rounded-full bg-panel-2 px-3 py-1 font-mono text-xs font-medium text-ink-3 transition-colors hover:text-ink-2'
                  }
                >
                  {tool}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tool-call policies</CardTitle>
          <CardDescription>
            Evaluated before a tool runs. <code className="font-mono text-2xs">deny</code> blocks
            the call outright; <code className="font-mono text-2xs">require_approval</code> holds
            the agent's request open until someone decides on the Approvals tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {policies.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="size-6" />} title="No tool-call policies">
              Every tool this agent can reach runs unchecked. Add a rule via{' '}
              <code className="font-mono text-2xs">PATCH /agents/{agentId}</code> to gate one —
              for example, requiring approval when a refund exceeds a threshold.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {policies.map((rule, index) => (
                <li key={index} className="flex flex-wrap items-baseline gap-2 px-6 py-3 text-sm">
                  <code className="font-mono font-medium text-ink">{rule.tool}</code>
                  {rule.field && (
                    <code className="font-mono text-2xs text-ink-3">
                      {rule.field}
                      {rule.condition &&
                        Object.entries(rule.condition).map(([op, value]) => ` ${op} ${value}`)}
                    </code>
                  )}
                  <span
                    className={
                      rule.action === 'deny'
                        ? 'rounded-full bg-danger/15 px-2 py-0.5 text-2xs font-medium text-danger-text'
                        : 'rounded-full bg-warn/12 px-2 py-0.5 text-2xs font-medium text-warn-text'
                    }
                  >
                    {rule.action}
                  </span>
                  {rule.reason && <span className="text-xs text-ink-3">{rule.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          <Save className="size-3.5" />
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
