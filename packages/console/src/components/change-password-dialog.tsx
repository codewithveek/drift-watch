import { useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { changePassword } from '@/lib/auth';

/** Mirrors better-auth's `minPasswordLength`; validated server-side regardless. */
const MIN_PASSWORD_LENGTH = 12;

export interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * False for an account still on its seeded password. The dialog then has no
   * close affordance and ignores Escape and outside clicks — see UserMenu for
   * why a bootstrap password is not something to postpone.
   */
  dismissible?: boolean;
}

export function ChangePasswordDialog({
  open,
  onOpenChange,
  dismissible = true,
}: ChangePasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setIsSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      // A full reload rather than a router refresh: changing the password
      // revokes other sessions and clears mustChangePassword, and re-entering
      // through a document request is the simplest way to be certain every
      // loader sees the new state.
      window.location.assign('/');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change the password.');
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={dismissible ? onOpenChange : undefined}>
      <DialogContent
        showCloseButton={dismissible}
        onEscapeKeyDown={(event) => !dismissible && event.preventDefault()}
        onPointerDownOutside={(event) => !dismissible && event.preventDefault()}
        onInteractOutside={(event) => !dismissible && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{dismissible ? 'Change password' : 'Set your password'}</DialogTitle>
          <DialogDescription>
            {dismissible
              ? 'You will be signed out of every other session.'
              : 'This account still uses the password from the deployment environment. Choose your own to continue.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              aria-describedby="new-password-hint"
            />
            <p
              id="new-password-hint"
              className={tooShort ? 'text-xs text-danger-text' : 'text-xs text-ink-3'}
            >
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            {mismatch && <p className="text-xs text-danger-text">Passwords do not match.</p>}
          </div>

          {error && (
            <Alert variant="destructive" aria-live="polite">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            {dismissible && (
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              disabled={isSubmitting || tooShort || mismatch || newPassword.length === 0}
            >
              {isSubmitting && <LoaderCircle className="size-4 animate-spin" />}
              {isSubmitting ? 'Saving…' : 'Change password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
