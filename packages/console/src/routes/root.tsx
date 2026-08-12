import type { ReactNode } from 'react';
import { Outlet, isRouteErrorResponse, useRouteError, useRouteLoaderData } from 'react-router';
import { AlertTriangle, KeyRound, RotateCw } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { AppSidebar } from '@/components/app-sidebar';
import { TokenDialog } from '@/components/token-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import type { FleetSummary } from '@/lib/fleet';

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
  const fleet = useRouteLoaderData('root') as FleetSummary | undefined;
  return (
    <Shell pendingCount={fleet?.pendingCount}>
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
            <KeyRound className="size-4" />
            <AlertTitle>This server needs a token</AlertTitle>
            <AlertDescription>
              <p>
                The control plane rejected the request. Set the bearer token matching the server's{' '}
                <code className="font-mono text-2xs">AUTH_TOKEN</code>, then retry.
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
          {unauthorized && <TokenDialog trigger={<Button>Set token</Button>} />}
          <Button variant={unauthorized ? 'outline' : 'default'} onClick={() => window.location.reload()}>
            <RotateCw className="size-3.5" />
            Retry
          </Button>
        </div>
      </div>
    </Shell>
  );
}
