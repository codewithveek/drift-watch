import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import '@fontsource-variable/inter';
import { ApiError } from './api.ts';
import { loadFleetSummary } from './lib/fleet.ts';
import type { RouteHandle } from './components/app-header.tsx';
import { RootErrorBoundary, RootLayout } from './routes/root.tsx';
import { FleetPage } from './routes/fleet.tsx';
import { ApprovalsPage } from './routes/approvals.tsx';
import { ActivityPage, activityLoader } from './routes/activity.tsx';
import { AgentLayout, agentLoader, type AgentLoaderData } from './routes/agent.tsx';
import { AgentOverviewPage, overviewLoader } from './routes/agent.overview.tsx';
import { AgentApprovalsPage, approvalsLoader } from './routes/agent.approvals.tsx';
import { AgentConfigPage, configLoader } from './routes/agent.config.tsx';
import { AgentAuditPage, auditLoader } from './routes/agent.audit.tsx';
import './index.css';

/**
 * Loaders run outside React, so a rejected fetch has no component to surface
 * it. Rethrowing as a Response routes it to the nearest errorElement with the
 * status intact, which is what lets the boundary tell "needs a token" (401)
 * apart from a genuine failure.
 */
function withErrorResponses<Args, Result>(
  loader: (args: Args) => Promise<Result>,
): (args: Args) => Promise<Result> {
  return async (args) => {
    try {
      return await loader(args);
    } catch (error) {
      if (error instanceof ApiError) {
        throw new Response(error.message, { status: error.status });
      }
      throw error;
    }
  };
}

/** Static breadcrumb label for routes whose crumb never depends on data. */
const staticCrumb = (label: string): RouteHandle => ({ crumb: () => ({ label }) });

const router = createBrowserRouter(
  [
    {
      id: 'root',
      path: '/',
      element: <RootLayout />,
      errorElement: <RootErrorBoundary />,
      // The fleet summary powers the overview, the fleet-wide approvals queue
      // and the sidebar's pending badge, so it is loaded once here rather than
      // three times.
      loader: withErrorResponses(loadFleetSummary),
      children: [
        { index: true, element: <FleetPage />, handle: staticCrumb('Overview') },
        { path: 'approvals', element: <ApprovalsPage />, handle: staticCrumb('Approvals') },
        {
          id: 'activity',
          path: 'activity',
          element: <ActivityPage />,
          loader: withErrorResponses(activityLoader),
          handle: staticCrumb('Activity'),
        },
        {
          id: 'agent',
          path: 'agents/:agentId',
          element: <AgentLayout />,
          loader: withErrorResponses(agentLoader),
          // The one crumb that has to read loader data: an id in the trail
          // would be correct and useless.
          handle: {
            crumb: (data) => ({
              label: (data as AgentLoaderData | undefined)?.definition.name ?? 'Agent',
            }),
          } satisfies RouteHandle,
          children: [
            {
              id: 'agent-overview',
              index: true,
              element: <AgentOverviewPage />,
              loader: withErrorResponses(overviewLoader),
              handle: staticCrumb('Overview'),
            },
            {
              id: 'agent-approvals',
              path: 'approvals',
              element: <AgentApprovalsPage />,
              loader: withErrorResponses(approvalsLoader),
              handle: staticCrumb('Approvals'),
            },
            {
              id: 'agent-config',
              path: 'config',
              element: <AgentConfigPage />,
              loader: withErrorResponses(configLoader),
              handle: staticCrumb('Config'),
            },
            {
              id: 'agent-audit',
              path: 'audit',
              element: <AgentAuditPage />,
              loader: withErrorResponses(auditLoader),
              handle: staticCrumb('Audit'),
            },
          ],
        },
      ],
    },
  ],
  {
    // Single-sourced from Vite's `base`. Hardcoding '/console' in a second place
    // is how the preview build silently breaks.
    basename: import.meta.env.BASE_URL,
  },
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
