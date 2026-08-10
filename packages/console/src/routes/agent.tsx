import { NavLink, Outlet, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { client, type AgentDefinition, type StateResponse } from '@/api';
import { cn } from '@/lib/utils';
import { StatusDot, STATUS_LABEL } from '@/components/domain';

export interface AgentLoaderData {
  agentId: string;
  definition: AgentDefinition;
  state: StateResponse;
}

export async function agentLoader({ params }: LoaderFunctionArgs): Promise<AgentLoaderData> {
  const agentId = params.agentId!;
  const [{ agent: definition }, state] = await Promise.all([
    client.getAgent(agentId),
    client.getState(agentId),
  ]);
  return { agentId, definition, state };
}

const TABS = [
  { to: '.', label: 'Overview', end: true },
  { to: 'approvals', label: 'Approvals' },
  { to: 'config', label: 'Config' },
  { to: 'audit', label: 'Audit' },
];

export function AgentLayout() {
  const { definition, state } = useLoaderData() as AgentLoaderData;

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/"
          className="mb-2 inline-flex items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink-2"
        >
          <ArrowLeft className="size-3" />
          Fleet
        </Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold text-ink">{definition.name}</h1>
          <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
            <StatusDot status={state.agent.status} ping />
            {STATUS_LABEL[state.agent.status]}
          </span>
        </div>
        <p className="font-mono text-2xs text-ink-3">{definition.id}</p>
      </div>

      {/* Routed tabs rather than shadcn Tabs: the active tab IS the URL, so it
          must survive a deep link and a refresh. */}
      <nav className="flex gap-1 border-b border-line" aria-label="Agent sections">
        {TABS.map((tab) => (
          <NavLink
            key={tab.label}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border-brand text-ink'
                  : 'border-transparent text-ink-3 hover:border-line-2 hover:text-ink-2',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
