import { NavLink, useLocation, useRouteLoaderData } from 'react-router';
import { Activity, Bot, KeyRound, LayoutGrid, ScrollText, ShieldCheck } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { UserMenu } from '@/components/user-menu';
import type { RootData } from '@/routes/root';

/**
 * The permanent left rail.
 *
 * One flat group of destinations. This previously enumerated every registered
 * agent in the rail, on the reasoning that a fleet operator should see at a
 * glance which agent is paused or holding a request open. That reasoning does
 * not survive scale — a rail is fine at four agents and unusable at fifty — and
 * the information it carried is better served by the dashboard's status roll-up
 * and the /agents inventory, which can sort, filter and search.
 */

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutGrid, exact: true },
  { to: '/agents', label: 'Agents', icon: Bot, exact: false },
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
  const data = useRouteLoaderData('root') as RootData | undefined;
  const agentCount = data?.agents.length ?? 0;
  const pendingCount = data?.pendingCount ?? 0;

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
              {NAV_ITEMS.map(({ to, label, icon: Icon, exact }) => {
                // Two different counts, on two different items: how many agents
                // exist (informational) and how many things are waiting on a
                // human (actionable). Only the second is tinted.
                const badge =
                  to === '/approvals' && pendingCount > 0
                    ? { value: pendingCount, urgent: true }
                    : to === '/agents' && agentCount > 0
                      ? { value: agentCount, urgent: false }
                      : undefined;
                return (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive(to, exact)}
                      className={ACTIVE_ITEM}
                    >
                      <NavLink to={to} end={exact}>
                        <Icon />
                        <span>{label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                    {badge && (
                      <SidebarMenuBadge className={badge.urgent ? 'text-warn-text' : 'text-ink-3'}>
                        {badge.value}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <UserMenu user={data?.user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
