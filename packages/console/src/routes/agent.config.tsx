import { useState } from 'react';
import { useParams, useRevalidator, useRouteLoaderData } from 'react-router';
import { RotateCcw, Save } from 'lucide-react';
import { client, type AgentConfig, type ToolCallPolicyRule, type ToolMetadata } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PolicyEditor } from '@/components/policy-editor';
import { Notice } from '@/components/domain';
import { cn } from '@/lib/utils';
import type { AgentLoaderData } from './agent';

export interface ConfigLoaderData {
  allTools: ToolMetadata[];
}

export async function configLoader({
  params,
}: {
  params: { agentId?: string };
}): Promise<ConfigLoaderData> {
  // Per-agent, not fleet-wide: an SDK-registered agent declares its own tools,
  // and offering this server's demo registry instead would let an operator
  // author rules for tools the agent cannot call while hiding the ones it can.
  const { tools } = await client.getAgentTools(params.agentId!);
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
  const { definition, override, overriddenFields, state } = useRouteLoaderData(
    'agent',
  ) as AgentLoaderData;
  const { allTools } = useRouteLoaderData('agent-config') as ConfigLoaderData;
  const revalidator = useRevalidator();

  // Initialized once from loader data — deliberately NOT synced via useEffect,
  // which would clobber whatever the operator is typing on the next poll.
  /*
   * Seeded from the OVERRIDE where one exists, falling back to what the code
   * declared. This form edits the override layer — seeding it from the resolved
   * view instead would bake deployment defaults and inherited values in as
   * explicit local overrides the moment anyone pressed Save.
   */
  const [guardrails, setGuardrails] = useState<Partial<AgentConfig>>(
    () => override?.guardrails ?? definition.guardrails ?? {},
  );
  const [toolNames, setToolNames] = useState<string[]>(
    () => override?.toolNames ?? definition.toolNames ?? allTools.map((tool) => tool.name),
  );
  // The agent's OWN rules, not the resolved set — editing must not silently
  // absorb rules inherited via toolPoliciesSource and bake them in as local.
  const [policies, setPolicies] = useState<ToolCallPolicyRule[]>(
    () => override?.toolPolicies ?? definition.toolPolicies ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Enables the save bar. Without it the bar is always live and gives no signal
  // about whether there is anything to save.
  const [dirty, setDirty] = useState(false);

  const inheritedCount = (state.toolPolicies?.length ?? 0) - policies.length;

  function touch() {
    setSaved(false);
    setDirty(true);
  }

  const [reverting, setReverting] = useState(false);

  /**
   * Drops every console override so the agent falls back to its own declared
   * config. A full reload rather than a revalidate: the form's state was seeded
   * from the override that no longer exists, and re-seeding it correctly means
   * re-entering through the loader.
   */
  async function revert() {
    setReverting(true);
    setError(null);
    try {
      await client.revertAgentOverride(agentId!);
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to revert');
      setReverting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await client.updateAgent(agentId!, { guardrails, toolNames, toolPolicies: policies });
      setSaved(true);
      setDirty(false);
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 pb-20">
      {overriddenFields.length > 0 && (
        <Notice tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              This agent is running with console overrides on{' '}
              <strong className="font-medium">{overriddenFields.join(', ')}</strong>. Its own code
              declares different values — a redeploy will not change what is in force here.
            </span>
            <Button size="sm" variant="outline" onClick={revert} disabled={reverting}>
              <RotateCcw className="size-3.5" />
              {reverting ? 'Reverting…' : 'Revert to code'}
            </Button>
          </div>
        </Notice>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {saved && !error && (
        <Notice tone="success">
          Saved. This applies to the agent's next run — no restart needed.
        </Notice>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Guardrails</CardTitle>
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
                    touch();
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
          <CardTitle className="text-base">Tools</CardTitle>
          <CardDescription>
            The tools this agent declares.{' '}
            <span className="tabular-nums">{toolNames.length}</span> of{' '}
            <span className="tabular-nums">{allTools.length}</span> enabled.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {allTools.map(({ name: tool, destructive }) => {
              const enabled = toolNames.includes(tool);
              return (
                <button
                  key={tool}
                  type="button"
                  aria-pressed={enabled}
                  title={destructive ? `${tool} — marked destructive` : tool}
                  onClick={() => {
                    touch();
                    setToolNames((current) =>
                      current.includes(tool)
                        ? current.filter((name) => name !== tool)
                        : [...current, tool],
                    );
                  }}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-xs font-medium transition-colors',
                    enabled
                      ? 'bg-brand text-primary-foreground hover:bg-brand-hover'
                      : 'bg-panel-2 text-ink-3 hover:text-ink-2',
                  )}
                >
                  {destructive && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-1.5 rounded-full',
                        enabled ? 'bg-primary-foreground/70' : 'bg-danger',
                      )}
                    />
                  )}
                  {tool}
                </button>
              );
            })}
          </div>
          {allTools.some((tool) => tool.destructive) && (
            <p className="mt-3 text-2xs text-ink-3">
              A dot marks a tool the registry reports as destructive. That is descriptive only —
              nothing is gated until a policy below says so.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tool-call policies</CardTitle>
          <CardDescription>
            Evaluated before a tool runs. <code className="font-mono text-2xs">deny</code> blocks
            the call outright; <code className="font-mono text-2xs">require_approval</code> holds
            the agent's request open until someone decides on the Approvals tab.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PolicyEditor
            rules={policies}
            tools={allTools}
            onChange={(next) => {
              touch();
              setPolicies(next);
            }}
          />
          {inheritedCount > 0 && (
            <p className="mt-3 text-2xs text-ink-3">
              Plus {inheritedCount} rule{inheritedCount === 1 ? '' : 's'} inherited from{' '}
              <code className="font-mono">{definition.toolPoliciesSource}</code>, which also apply
              and are edited on that agent.
            </p>
          )}
        </CardContent>
      </Card>

      {/*
        A save bar pinned to the viewport, not a button at the end of the page.
        This form is three cards tall; a Save that scrolls out of view while you
        edit the third one is the reason config screens get abandoned half-done.
        It exists only while there is something to save — a permanently floating
        disabled button would just be furniture hovering over the content.
      */}
      {dirty && (
        <div className="sticky bottom-4 z-(--z-sticky) flex justify-end motion-safe:animate-[queue-in_200ms_var(--ease-out-quint)_both]">
          <div className="flex items-center gap-3 rounded-full border border-line bg-panel py-2 pr-2 pl-4 shadow-md">
            <span className="text-xs text-ink-3">Unsaved changes</span>
            <Button size="sm" onClick={save} disabled={saving}>
              <Save className="size-3.5" />
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
