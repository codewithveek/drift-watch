import type { ReactNode } from 'react';
import { Outlet, isRouteErrorResponse, redirect, useRouteError, useRouteLoaderData } from 'react-router';
import { AlertTriangle, LogIn, RotateCw } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { AppSidebar } from '@/components/app-sidebar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { getSession, type SessionUser } from '@/lib/auth';
import { loadFleetSummary, type FleetSummary } from '@/lib/fleet';

/** Everything the shell and its children need on every navigation. */
export interface RootData extends FleetSummary {
  user: SessionUser;
}

/**
 * The auth gate for the entire console.
 *
 * Checking the session HERE rather than in a component is what makes the guard
 * real: loaders run before anything renders, so an unauthenticated visitor never
 * sees a flash of the dashboard, and no child route can forget to check. It also
 * means a 401 arriving mid-session (an expired or revoked cookie) bounces to
 * sign-in on the next navigation instead of showing a broken page.
 *
 * The current path is carried through as `next` so following a deep link while
 * logged out — a Slack approval link, a bookmarked agent — lands where it was
 * aimed after signing in rather than dumping the operator on the dashboard.
 *
 * `getSession` runs first and alone: firing the fleet fan-out concurrently would
 * mean a dozen requests that are certain to 401 on every visit from a logged-out
 * browser.
 */
export async function rootLoader(): Promise<RootData | Response> {
  const user = await getSession();
  if (!user) {
    const next = `${window.location.pathname}${window.location.search}`;
    return redirect(next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`);
  }
  const fleet = await loadFleetSummary();
  return { ...fleet, user };
}

/**
 * Reads the rail's collapsed state back from the cookie shadcn's
 * SidebarProvider writes. Without this the sidebar silently springs back open
 * on every reload, which makes the toggle feel broken rather than persistent.
 */
function sidebarDefaultOpen(): boolean {
  if (typeof document === 'undefined') return true;
  return !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(document.cookie);
}

function Shell({ pendingCount, children }: { pendingCount?: number; children: ReactNode }) {
  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen()}>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <AppHeader pendingCount={pendingCount} />
        {/* max-w-368 = 92rem. Wide enough for a four-up metric row plus a
            2:1 chart/list split at 1080p, capped so a 4K display doesn't
            stretch table rows to an unreadable line length. */}
        <div className="mx-auto w-full max-w-368 px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function RootLayout() {
  const data = useRouteLoaderData('root') as RootData | undefined;
  return (
    <Shell pendingCount={data?.pendingCount}>
      <Outlet />
    </Shell>
  );
}

/**
 * Loaders run outside React, so a failed fetch surfaces here rather than in a
 * component's own error state. 401 is by far the most likely and has a
 * specific remedy, so it gets its own treatment — and the remedy is offered
 * inline as the primary action rather than described in prose and left to the
 * reader to go find.
 */
export function RootErrorBoundary() {
  const error = useRouteError();

  const unauthorized = isRouteErrorResponse(error) && error.status === 401;
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <Shell>
      <div className="mx-auto max-w-2xl py-6">
        {unauthorized ? (
          <Alert>
            <LogIn className="size-4" />
            <AlertTitle>Your session has ended</AlertTitle>
            <AlertDescription>
              <p>
                The control plane rejected this request. Your session may have expired or been
                revoked — sign in again to continue.
              </p>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>{notFound ? 'Not found' : 'Something went wrong'}</AlertTitle>
            <AlertDescription>
              <p>
                {isRouteErrorResponse(error)
                  ? `${error.status} ${error.statusText || ''} ${
                      typeof error.data === 'string' ? error.data : ''
                    }`.trim()
                  : error instanceof Error
                    ? error.message
                    : 'Unknown error.'}
              </p>
            </AlertDescription>
          </Alert>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {unauthorized && (
            // A full page load, not a client-side navigation: the router's own
            // state is what just failed, so re-entering through the document
            // request is the reliable way back to a clean loader run.
            <Button onClick={() => window.location.assign('/login')}>
              <LogIn className="size-3.5" />
              Sign in
            </Button>
          )}
          <Button
            variant={unauthorized ? 'outline' : 'default'}
            onClick={() => window.location.reload()}
          >
            <RotateCw className="size-3.5" />
            Retry
          </Button>
        </div>
      </div>
    </Shell>
  );
}
