import { useState } from 'react';
import { Link, useNavigation } from 'react-router';
import { Activity, KeyRound, Loader2, Moon, Sun } from 'lucide-react';
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
import { getToken, setToken } from '@/api';
import { getTheme, setTheme, type Theme } from '@/lib/theme';

function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => {
        setTheme(next);
        setThemeState(next);
      }}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

/**
 * Bearer-token entry. A Dialog rather than the hand-rolled popover this
 * replaces: it gets focus trapping, Escape handling and correct stacking for
 * free, none of which the original had.
 */
function TokenDialog() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(getToken);
  const configured = getToken().length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          <KeyRound className="size-3.5" />
          <span className="hidden sm:inline">{configured ? 'Token set' : 'Set token'}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API token</DialogTitle>
          <DialogDescription>
            Sent as <code className="font-mono text-2xs">Authorization: Bearer</code> on every
            request. Stored in this browser only. Leave it empty if the server runs without{' '}
            <code className="font-mono text-2xs">AUTH_TOKEN</code> — it then accepts local
            requests only.
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

export function TopBar({ pendingCount }: { pendingCount?: number }) {
  const navigation = useNavigation();

  return (
    <header className="sticky top-0 z-[var(--z-sticky)] border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-md text-sm font-semibold text-ink transition-colors hover:text-brand-bright"
        >
          <Activity className="size-4 text-brand-bright" />
          DriftWatch
        </Link>

        {navigation.state === 'loading' && (
          <Loader2 className="size-3.5 animate-spin text-ink-3" aria-label="Loading" />
        )}

        <div className="ml-auto flex items-center gap-1">
          {pendingCount !== undefined && pendingCount > 0 && (
            <Link
              to="/"
              className="mr-1 inline-flex items-center gap-1.5 rounded-full bg-warn/12 px-2.5 py-1 text-xs font-medium text-warn-text transition-colors hover:bg-warn/20"
            >
              <span className="tabular-nums">{pendingCount}</span> awaiting approval
            </Link>
          )}
          <TokenDialog />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
