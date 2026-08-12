import { NavLink, useLocation, useRouteLoaderData } from 'react-router';
import {
  Activity,
  Fingerprint,
  KeyRound,
  LayoutGrid,
  Plus,
  ScrollText,
  ShieldCheck,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { RegisterAgentDialog } from '@/components/register-agent-dialog';
import { TokenDialog } from '@/components/token-dialog';
import { StatusDot } from '@/components/domain';
import { getToken } from '@/api';
import { cn } from '@/lib/utils';
import type { FleetSummary } from '@/lib/fleet';

/**
 * The permanent left rail.
 *
 * Two groups, because the fleet has two kinds of destination: the control
 * centre (things you DO — triage, review, audit) and the agents themselves
 * (things you INSPECT). Listing every agent in the rail rather than hiding
 * them behind an "Agents" link is the point of a fleet console: an operator
 * watching four agents should never have to navigate to find out which one is
 * paused, or which one is holding a request open.
 */

const CONTROL_CENTER = [
  { to: '/', label: 'Overview', icon: LayoutGrid, exact: true },
  { to: '/approvals', label: 'Approvals', icon: ShieldCheck, exact: false },
  { to: '/activity', label: 'Activity', icon: ScrollText, exact: false },
  { to: '/settings/api-keys', label: 'API keys', icon: KeyRound, exact: false },
] as const;

/**
 * Active nav is the one place the brand tint appears in the rail. Hover keeps
 * the neutral raised surface it inherits from shadcn, so "where I am" and
 * "what I'm pointing at" never resolve to the same treatment.
 */
const ACTIVE_ITEM =
  'data-[active=true]:bg-brand/10 data-[active=true]:font-medium data-[active=true]:text-brand-bright data-[active=true]:hover:bg-brand/15 data-[active=true]:hover:text-brand-bright';

export function AppSidebar() {
  // Undefined inside the root error boundary, which renders the same shell so a
  // failed load still has navigation instead of a bare error page.
  const fleet = useRouteLoaderData('root') as FleetSummary | undefined;
  const agents = fleet?.agents ?? [];
  const pendingCount = fleet?.pendingCount ?? 0;
  const tokenConfigured = getToken().length > 0;

  /*
   * Active state is derived here rather than from NavLink's render prop:
   * SidebarMenuButton needs the boolean as a PROP (it drives `data-active`),
   * and asChild takes a single element, so the render-prop form would force the
   * anchor to wrap the button instead of being it — an unstyled inline <a>
   * around a full-width control, which breaks both layout and the hit area.
   */
  const { pathname } = useLocation();
  const isActive = (to: string, exact: boolean) =>
    exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);

  return (
    <Sidebar>
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-4">
        <NavLink to="/" className="flex items-center gap-2 rounded-md">
          <span className="grid size-6 place-items-center rounded-md bg-brand text-primary-foreground">
            <Activity className="size-3.5" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink">DriftWatch</span>
        </NavLink>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Control center</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {CONTROL_CENTER.map(({ to, label, icon: Icon, exact }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton asChild isActive={isActive(to, exact)} className={ACTIVE_ITEM}>
                    <NavLink to={to} end={exact}>
                      <Icon />
                      <span>{label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                  {to === '/approvals' && pendingCount > 0 && (
                    <SidebarMenuBadge className="text-warn-text">{pendingCount}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>
            Agents
            {agents.length > 0 && (
              <span className="ml-1.5 tabular-nums text-ink-3">{agents.length}</span>
            )}
          </SidebarGroupLabel>
          <RegisterAgentDialog
            trigger={
              <SidebarGroupAction title="Register agent">
                <Plus />
                <span className="sr-only">Register agent</span>
              </SidebarGroupAction>
            }
          />
          <SidebarGroupContent>
            {agents.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-ink-3">
                None registered yet. A deployment registers its own on first run.
              </p>
            ) : (
              <SidebarMenu>
                {agents.map(({ definition, state, pendingApprovals, pendingToolCalls }) => {
                  const awaiting = pendingApprovals + pendingToolCalls;
                  const to = `/agents/${definition.id}`;
                  return (
                    <SidebarMenuItem key={definition.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive(to, false)}
                        className={ACTIVE_ITEM}
                      >
                        <NavLink to={to}>
                          <StatusDot status={state.status} />
                          <span className="truncate">{definition.name}</span>
                        </NavLink>
                      </SidebarMenuButton>
                      {awaiting > 0 && (
                        <SidebarMenuBadge className="text-warn-text">{awaiting}</SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <TokenDialog
              trigger={
                <SidebarMenuButton className="text-ink-3">
                  {/* Fingerprint, not KeyRound: this is "how THIS browser
                      authenticates", distinct from the API keys page above. */}
                  <Fingerprint />
                  <span>{tokenConfigured ? 'Token set' : 'No token set'}</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'ml-auto size-1.5 shrink-0 rounded-full',
                      tokenConfigured ? 'bg-ok' : 'bg-line-2',
                    )}
                  />
                </SidebarMenuButton>
              }
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
