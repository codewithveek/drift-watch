import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus } from 'lucide-react';
import { client } from '@/api';
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

/**
 * Registers an agent. Only identity is captured here — guardrails, tools and
 * tool-call policies are edited on the agent's own Config tab once it exists,
 * rather than front-loading every field into a creation form nobody can fill
 * in meaningfully yet.
 */
export function RegisterAgentDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [owner, setOwner] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setId('');
    setOwner('');
    setServiceName('');
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { agent } = await client.registerAgent({
        name: name.trim(),
        ...(id.trim() ? { id: id.trim() } : {}),
        ...(owner.trim() ? { owner: owner.trim() } : {}),
        ...(serviceName.trim() ? { serviceName: serviceName.trim() } : {}),
      });
      setOpen(false);
      reset();
      // Land on the new agent: it confirms the write and is where you'd go next.
      navigate(`/agents/${agent.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to register');
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
          Register agent
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Register an agent</DialogTitle>
            <DialogDescription>
              Adds an entry to the registry so this agent can be monitored and controlled.
              Guardrails and tool policies are set afterwards on its Config tab.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={name}
                required
                autoFocus
                placeholder="Payment Agent"
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="agent-id">
                ID <span className="font-normal text-ink-3">(optional)</span>
              </Label>
              <Input
                id="agent-id"
                value={id}
                pattern="[a-zA-Z0-9_\-]+"
                placeholder="derived from the name, e.g. payment-agent-9e930e"
                onChange={(event) => setId(event.target.value)}
              />
              <p className="text-2xs text-ink-3">
                Letters, numbers, dashes and underscores. This becomes the{' '}
                <code className="font-mono">agent_id</code> label on every metric, so leaving it
                blank (for a readable generated slug) is usually right.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="agent-owner">
                  Owner <span className="font-normal text-ink-3">(optional)</span>
                </Label>
                <Input
                  id="agent-owner"
                  value={owner}
                  placeholder="payments-team"
                  onChange={(event) => setOwner(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="agent-service">
                  Service name <span className="font-normal text-ink-3">(optional)</span>
                </Label>
                <Input
                  id="agent-service"
                  value={serviceName}
                  placeholder="OTel service.name"
                  onChange={(event) => setServiceName(event.target.value)}
                />
              </div>
            </div>
          </div>

          {error && (
            <p className="mb-2 rounded-md bg-danger/12 px-3 py-2 text-sm text-danger-text" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || name.trim().length === 0}>
              {saving ? 'Registering…' : 'Register'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
