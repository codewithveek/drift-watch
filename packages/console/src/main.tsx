import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ApiError } from './api.ts';
import { loadFleetSummary } from './lib/fleet.ts';
import { RootErrorBoundary, RootLayout } from './routes/root.tsx';
import { FleetPage } from './routes/fleet.tsx';
import { AgentLayout, agentLoader } from './routes/agent.tsx';
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

const router = createBrowserRouter([
  {
    id: 'root',
    path: '/',
    element: <RootLayout />,
    errorElement: <RootErrorBoundary />,
    // The fleet summary powers both the landing page and the top bar's
    // fleet-wide pending badge, so it is loaded once here rather than twice.
    loader: withErrorResponses(loadFleetSummary),
    children: [
      { index: true, element: <FleetPage /> },
      {
        id: 'agent',
        path: 'agents/:agentId',
        element: <AgentLayout />,
        loader: withErrorResponses(agentLoader),
        children: [
          {
            id: 'agent-overview',
            index: true,
            element: <AgentOverviewPage />,
            loader: withErrorResponses(overviewLoader),
          },
          {
            id: 'agent-approvals',
            path: 'approvals',
            element: <AgentApprovalsPage />,
            loader: withErrorResponses(approvalsLoader),
          },
          {
            id: 'agent-config',
            path: 'config',
            element: <AgentConfigPage />,
            loader: withErrorResponses(configLoader),
          },
          {
            id: 'agent-audit',
            path: 'audit',
            element: <AgentAuditPage />,
            loader: withErrorResponses(auditLoader),
          },
        ],
      },
    ],
  },
], {
  // Single-sourced from Vite's `base`. Hardcoding '/console' in a second place
  // is how the preview build silently breaks.
  basename: import.meta.env.BASE_URL,
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
