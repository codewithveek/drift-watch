import { useState } from 'react';
import { Check, Copy, KeyRound, Plus, TriangleAlert } from 'lucide-react';
import { client, type AgentDefinition, type ApiKeyScope, type CreatedApiKey } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface ScopeOption {
  name: ApiKeyScope;
  description: string;
}

/**
 * Mint a key.
 *
 * Two states in one dialog rather than two dialogs, because the second state
 * is the whole point of the first: the plaintext token exists in exactly one
 * HTTP response and is unrecoverable afterwards. Closing the reveal panel
 * destroys it, so the panel says so and the close button is labelled for the
 * consequence ("Done — I've copied it") rather than the mechanic.
 *
 * Scope options come from the server (`GET /api-keys`) rather than a local
 * constant: this package can only import SDK *types*, since the SDK's runtime
 * entry pulls in OpenTelemetry.
 */
export function CreateApiKeyDialog({
  scopeOptions,
  agents,
  onCreated,
}: {
  scopeOptions: ScopeOption[];
  agents: AgentDefinition[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['read']);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  function reset() {
    setName('');
    setScopes(['read']);
    setAgentIds([]);
    setExpiresInDays('');
    setError(null);
    setCreated(null);
  }

  function toggle<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const days = Number(expiresInDays);
      const result = await client.createApiKey({
        name: name.trim(),
        scopes,
        ...(agentIds.length > 0 ? { agentIds } : {}),
        ...(expiresInDays.trim() && Number.isFinite(days) && days > 0
          ? { expiresAt: Date.now() + days * 24 * 60 * 60 * 1000 }
          : {}),
      });
      setCreated(result);
      // Refresh the list behind the reveal panel so the new row is already
      // there when the panel closes.
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create key');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-3.5" />
          Create key
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {created ? (
          <RevealPanel created={created} onDone={() => setOpen(false)} />
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Create an API key</DialogTitle>
              <DialogDescription>
                Grant the narrowest set of scopes that does the job. The token is shown once, on
                the next screen, and cannot be retrieved afterwards.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-5 py-4">
              <div className="grid gap-1.5">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  value={name}
                  required
                  autoFocus
                  placeholder="CI deploy key"
                  onChange={(event) => setName(event.target.value)}
                />
                <p className="text-2xs text-ink-3">
                  Shown in the key list and in every audit entry this key produces.
                </p>
              </div>

              <fieldset className="grid gap-2">
                <legend className="mb-1.5 text-sm font-medium text-ink">Scopes</legend>
                {scopeOptions.map((option) => (
                  <label
                    key={option.name}
                    className={cn(
                      'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors',
                      scopes.includes(option.name)
                        ? 'border-brand/40 bg-brand/5'
                        : 'border-line hover:bg-accent',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5 accent-brand"
                      checked={scopes.includes(option.name)}
                      onChange={() => setScopes((current) => toggle(current, option.name))}
                    />
                    <span className="grid gap-0.5">
                      <code className="font-mono text-2xs text-ink">{option.name}</code>
                      <span className="text-2xs text-ink-3">{option.description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium text-ink">Agent access</legend>
                <p className="-mt-1 mb-1 text-2xs text-ink-3">
                  Select none for a fleet-wide key. Selecting agents restricts this key to them —
                  every other agent returns 403, and the key cannot perform fleet-wide operations
                  such as registering a new agent or scanning the whole fleet.
                </p>
                {agents.length === 0 ? (
                  <p className="text-2xs text-ink-3">No agents registered yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {agents.map((agent) => {
                      const selected = agentIds.includes(agent.id);
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => setAgentIds((current) => toggle(current, agent.id))}
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-2xs transition-colors',
                            selected
                              ? 'border-brand/40 bg-brand/10 text-brand-bright'
                              : 'border-line text-ink-2 hover:bg-accent',
                          )}
                        >
                          {agent.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </fieldset>

              <div className="grid gap-1.5">
                <Label htmlFor="key-expiry">
                  Expires in <span className="font-normal text-ink-3">(optional)</span>
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="key-expiry"
                    type="number"
                    min={1}
                    className="w-28"
                    value={expiresInDays}
                    placeholder="90"
                    onChange={(event) => setExpiresInDays(event.target.value)}
                  />
                  <span className="text-xs text-ink-3">days — blank means it never expires.</span>
                </div>
              </div>
            </div>

            {error && (
              <p
                className="mb-2 rounded-md bg-danger/12 px-3 py-2 text-sm text-danger-text"
                role="alert"
              >
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !name.trim() || scopes.length === 0}>
                {saving ? 'Creating…' : 'Create key'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The one and only time the plaintext token is displayable. */
function RevealPanel({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is unavailable over plain HTTP on a non-localhost origin.
      // The token is selectable in the field, so this is a degraded path, not
      // a dead end — say nothing rather than throwing an error at someone who
      // can simply select it.
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-brand" />
          {created.key.name}
        </DialogTitle>
        <DialogDescription>
          Copy this token now. It is stored only as a hash, so this is the last time it can be
          shown — if you lose it, revoke the key and create another.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2 py-2">
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={created.token}
            aria-label="API token"
            className="font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button type="button" variant="outline" size="sm" onClick={copy} className="shrink-0">
            {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="flex items-start gap-1.5 text-2xs text-warn-text">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          Anyone holding this token has its scopes. Store it in a secret manager, not in source
          control.
        </p>
      </div>

      <DialogFooter>
        <Button type="button" onClick={onDone}>
          Done — I&rsquo;ve copied it
        </Button>
      </DialogFooter>
    </>
  );
}
