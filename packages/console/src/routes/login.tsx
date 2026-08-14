import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Activity, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AuthError, signIn } from '@/lib/auth';

/**
 * The sign-in page.
 *
 * Replaces the old "paste your AUTH_TOKEN into a dialog" flow. That asked every
 * operator to hold the deployment's most privileged secret, and attributed
 * everything they did to `root`.
 *
 * There is deliberately no "create an account" link: sign-up is disabled
 * server-side, the first admin comes from DW_USER/DW_PASSWORD at deploy time,
 * and everyone after that is created by an admin. A self-service link would
 * either 404 or, worse, suggest the instance is open to registration.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * Where to land after a successful sign-in. Set by the root loader when it
   * bounces an unauthenticated deep link, so following a Slack approval link
   * while logged out still ends up at the approval rather than the dashboard.
   */
  const redirectTo = searchParams.get('next') || '/';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setIsSubmitting(true);
    try {
      await signIn(email, password);
      // `replace` so the browser Back button cannot return to a login form for a
      // session that now exists.
      await navigate(redirectTo, { replace: true });
    } catch (caught) {
      setError(
        caught instanceof AuthError && caught.status === 401
          ? // Never distinguish "no such user" from "wrong password": the
            // difference tells an attacker which addresses are real.
            'Incorrect email or password.'
          : caught instanceof Error
            ? caught.message
            : 'Sign-in failed.',
      );
      setIsSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-center gap-2">
          <span className="grid size-7 place-items-center rounded-md bg-brand text-primary-foreground">
            <Activity className="size-4" />
          </span>
          <span className="text-base font-semibold tracking-tight text-ink">DriftWatch</span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Use the account your administrator created for you.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  // The first field is where an operator expects the caret; not
                  // autofocusing means a wasted click on every sign-in.
                  autoFocus
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              {error && (
                // aria-live so a screen reader announces a failure that appears
                // without any navigation.
                <Alert variant="destructive" aria-live="polite">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting && <LoaderCircle className="size-4 animate-spin" />}
                {isSubmitting ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-ink-3">
          First run? The initial administrator is created from the DW_USER and DW_PASSWORD
          environment variables.
        </p>
      </div>
    </main>
  );
}
