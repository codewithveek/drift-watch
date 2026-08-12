import { NavLink, Outlet, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { client, type AgentDefinition, type StateResponse } from '@/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
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
  const { agent } = state;

  return (
    <div className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{definition.name}</h1>
          <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
            <StatusDot status={agent.status} ping />
            {STATUS_LABEL[agent.status]}
          </span>
          {agent.activeModel && (
            <Badge className="border-transparent bg-panel-2 font-mono font-medium text-ink-2">
              {agent.activeModel}
            </Badge>
          )}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-3">
          <span className="font-mono">{definition.id}</span>
          {definition.owner && (
            <>
              <span aria-hidden="true">·</span>
              <span>owned by {definition.owner}</span>
            </>
          )}
          {definition.serviceName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{definition.serviceName}</span>
            </>
          )}
        </p>
      </header>

      {/* Routed tabs rather than shadcn Tabs: the active tab IS the URL, so it
          must survive a deep link and a refresh. */}
      <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-line" aria-label="Agent sections">
        {TABS.map((tab) => (
          <NavLink
            key={tab.label}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                '-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
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
