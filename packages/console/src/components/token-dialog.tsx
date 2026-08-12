import { useState, type ReactNode } from 'react';
import { getToken, setToken } from '@/api';
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
 * Bearer-token entry.
 *
 * A Dialog rather than a hand-rolled popover: focus trapping, Escape handling
 * and correct stacking come with it. The trigger is injected so the same
 * dialog can sit in the sidebar footer here and in an error boundary's
 * recovery path, without two copies of the form drifting apart.
 */
export function TokenDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(getToken);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API token</DialogTitle>
          <DialogDescription>
            Sent as <code className="font-mono text-2xs">Authorization: Bearer</code> on every
            request. Stored in this browser only. Leave it empty if the server runs without{' '}
            <code className="font-mono text-2xs">AUTH_TOKEN</code> — it then accepts local requests
            only.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="token">Bearer token</Label>
          <Input
            id="token"
            type="password"
            value={value}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
            placeholder="paste AUTH_TOKEN"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setToken(value);
              setOpen(false);
              // Loaders read the token at fetch time; a reload is the simplest
              // correct way to re-run every one of them with the new value.
              window.location.reload();
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
