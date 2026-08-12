import { useState } from 'react';
import { useRevalidator, useRouteLoaderData } from 'react-router';
import { KeyRound, ShieldOff } from 'lucide-react';
import {
  client,
  type AgentDefinition,
  type ApiKeysResponse,
  type PublicApiKey,
} from '@/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CreateApiKeyDialog, type ScopeOption } from '@/components/create-api-key-dialog';
import { EmptyState, SectionHeading, timeAgo, timeUntil } from '@/components/domain';
import { cn } from '@/lib/utils';

export interface ApiKeysLoaderData {
  keys: PublicApiKey[];
  scopes: ScopeOption[];
  agents: AgentDefinition[];
}

/**
 * The agent list is fetched alongside the keys so the create dialog can offer
 * per-agent scoping by NAME. It comes from /agents rather than the root
 * loader's fleet summary because that summary fans out one request per agent
 * for state and approvals — data this page has no use for.
 */
export async function apiKeysLoader(): Promise<ApiKeysLoaderData> {
  const [{ keys, scopes }, { agents }] = await Promise.all([
    client.getApiKeys() as Promise<ApiKeysResponse>,
    client.getAgents(),
  ]);
  return { keys, scopes, agents };
}

type KeyStatus = 'active' | 'revoked' | 'expired';

function statusOf(key: PublicApiKey, now: number): KeyStatus {
  if (key.revokedAt !== undefined) return 'revoked';
  if (key.expiresAt !== undefined && key.expiresAt <= now) return 'expired';
  return 'active';
}

const STATUS_STYLE: Record<KeyStatus, string> = {
  active: 'bg-ok/12 text-ok-text',
  revoked: 'bg-danger/12 text-danger-text',
  expired: 'bg-warn/12 text-warn-text',
};

export function ApiKeysPage() {
  const { keys, scopes, agents } = useRouteLoaderData('api-keys') as ApiKeysLoaderData;
  const revalidator = useRevalidator();
  const [revoking, setRevoking] = useState<PublicApiKey | null>(null);
  const now = Date.now();

  // Active first, then everything dead — a revoked key is history, and history
  // should not push today's credentials below the fold.
  const sorted = [...keys].sort((a, b) => {
    const rank = (key: PublicApiKey) => (statusOf(key, now) === 'active' ? 0 : 1);
    return rank(a) - rank(b) || b.createdAt - a.createdAt;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          as="h1"
          title="API keys"
          description="Scoped credentials for the control plane. Each key carries a set of permissions and, optionally, a list of agents it may touch."
        />
        <CreateApiKeyDialog
          scopeOptions={scopes}
          agents={agents}
          onCreated={() => revalidator.revalidate()}
        />
      </div>

      {/* Explanatory, not a result of an action — so a plain panel rather than
          Notice, which is the inline error/success affordance. */}
      <p className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-ink-2">
        <code className="font-mono text-2xs">AUTH_TOKEN</code> remains a full-access root
        credential and is not listed here — it is how the first key gets minted. Once you have a
        key with the scopes you need, prefer it over the root token, including in this console
        (paste it into the token dialog in the sidebar).
      </p>

      <Card className="overflow-hidden py-0">
        {sorted.length === 0 ? (
          <EmptyState icon={<KeyRound className="size-5" />} title="No API keys yet">
            A key lets a deploy pipeline, a script, or another operator reach the control plane
            without sharing the root token — and with only the permissions it actually needs.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-36">Prefix</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead className="w-40">Agents</TableHead>
                  <TableHead className="w-28">Last used</TableHead>
                  <TableHead className="w-32">Status</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((key) => {
                  const status = statusOf(key, now);
                  return (
                    <TableRow key={key.id} className={cn(status !== 'active' && 'opacity-60')}>
                      <TableCell className="text-sm text-ink">
                        {key.name}
                        <span className="block text-2xs text-ink-3">
                          created {timeAgo(key.createdAt, now)} by {key.createdBy}
                        </span>
                      </TableCell>
                      <TableCell>
                        {/* Identification only — the rest of the token is unrecoverable. */}
                        <code className="font-mono text-2xs text-ink-2">{key.prefix}…</code>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {key.scopes.map((scope) => (
                            <code
                              key={scope}
                              className="rounded bg-accent px-1.5 py-0.5 font-mono text-2xs text-ink-2"
                            >
                              {scope}
                            </code>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-2xs text-ink-2">
                        {key.agentIds && key.agentIds.length > 0 ? (
                          key.agentIds.join(', ')
                        ) : (
                          <span className="text-ink-3">fleet-wide</span>
                        )}
                      </TableCell>
                      <TableCell className="text-2xs text-ink-3">
                        {key.lastUsedAt ? timeAgo(key.lastUsedAt, now) : 'never'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-2xs font-medium',
                            STATUS_STYLE[status],
                          )}
                        >
                          {status}
                        </span>
                        {status === 'active' && key.expiresAt !== undefined && (
                          <span className="block pt-0.5 text-2xs text-ink-3">
                            expires in {timeUntil(key.expiresAt, now)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {status !== 'revoked' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-danger-text hover:bg-danger/10 hover:text-danger-text"
                            onClick={() => setRevoking(key)}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <RevokeDialog
        target={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={() => {
          setRevoking(null);
          revalidator.revalidate();
        }}
      />
    </div>
  );
}

/**
 * Revocation is immediate and irreversible, so it gets a confirmation naming
 * the key rather than an inline button that fires on the first click. The
 * record itself is kept (soft revoke) so the audit trail can still resolve
 * this key's id to a name.
 */
function RevokeDialog({
  target,
  onClose,
  onRevoked,
}: {
  target: PublicApiKey | null;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await client.revokeApiKey(target.id);
      onRevoked();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to revoke');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldOff className="size-4 text-danger-text" />
            Revoke “{target?.name}”?
          </DialogTitle>
          <DialogDescription>
            Every request using <code className="font-mono text-2xs">{target?.prefix}…</code> will
            start failing immediately. This cannot be undone — anything still using the key needs a
            new one. The key stays listed so past audit entries keep resolving to its name.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="rounded-md bg-danger/12 px-3 py-2 text-sm text-danger-text" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy}>
            {busy ? 'Revoking…' : 'Revoke key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
