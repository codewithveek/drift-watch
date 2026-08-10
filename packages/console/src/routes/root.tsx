import { Outlet, isRouteErrorResponse, useRouteError, useRouteLoaderData } from 'react-router';
import { AlertTriangle, KeyRound } from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export interface RootData {
  /** Fleet-wide count of things awaiting a human, surfaced in the top bar. */
  pendingCount?: number;
}

export function RootLayout() {
  const data = useRouteLoaderData('root') as RootData | undefined;
  return (
    <div className="min-h-screen">
      <TopBar pendingCount={data?.pendingCount} />
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Loaders run outside React, so a failed fetch surfaces here rather than in a
 * component's own error state. 401 is by far the most likely and has a
 * specific remedy, so it gets its own treatment instead of a generic message.
 */
export function RootErrorBoundary() {
  const error = useRouteError();

  const unauthorized = isRouteErrorResponse(error) && error.status === 401;
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <div className="min-h-screen">
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        {unauthorized ? (
          <Alert>
            <KeyRound className="size-4" />
            <AlertTitle>This server needs a token</AlertTitle>
            <AlertDescription>
              <p>
                The control plane rejected the request. Set the bearer token that matches the
                server's <code className="font-mono text-2xs">AUTH_TOKEN</code> using the button
                in the top bar, then retry.
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
        <div className="mt-4 flex gap-2">
          <Button onClick={() => window.location.reload()}>Retry</Button>
          <Button variant="outline" onClick={() => (window.location.href = import.meta.env.BASE_URL)}>
            Back to fleet
          </Button>
        </div>
      </main>
    </div>
  );
}
