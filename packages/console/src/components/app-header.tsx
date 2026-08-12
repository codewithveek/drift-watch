import { Fragment, useState } from 'react';
import { Link, useMatches, useNavigation, type Params } from 'react-router';
import { Loader2, Moon, Sun } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { getTheme, setTheme, type Theme } from '@/lib/theme';

export interface Crumb {
  label: string;
  /** Defaults to the matched route's own pathname. */
  to?: string;
}

/**
 * Route `handle` contract for the breadcrumb trail. Each route declares its own
 * crumb, so the trail is assembled from the route tree rather than by parsing
 * the URL — which is what lets `/agents/:id` render the agent's NAME.
 */
export interface RouteHandle {
  crumb?: (data: unknown, params: Params) => Crumb | null;
}

function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => {
        setTheme(next);
        setThemeState(next);
      }}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

export function AppHeader({ pendingCount = 0 }: { pendingCount?: number }) {
  const matches = useMatches();
  const navigation = useNavigation();

  const crumbs: Crumb[] = matches.flatMap((match) => {
    const crumb = (match.handle as RouteHandle | undefined)?.crumb?.(match.data, match.params);
    return crumb ? [{ label: crumb.label, to: crumb.to ?? match.pathname }] : [];
  });

  return (
    <header className="sticky top-0 z-(--z-sticky) flex h-14 shrink-0 items-center gap-2 border-b border-line bg-canvas/80 px-4 backdrop-blur-md sm:px-6">
      <SidebarTrigger className="-ml-1 text-ink-3" />
      <Separator orientation="vertical" className="mr-1 !h-4" />

      <Breadcrumb>
        <BreadcrumbList className="gap-1.5 sm:gap-1.5">
          <BreadcrumbItem className="hidden text-ink-3 sm:inline-flex">
            Control center
          </BreadcrumbItem>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <Fragment key={`${crumb.to}-${crumb.label}`}>
                <BreadcrumbSeparator className="hidden text-line-2 sm:block" />
                <BreadcrumbItem>
                  {last ? (
                    <BreadcrumbPage className="font-medium text-ink">{crumb.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild className="text-ink-3 hover:text-ink-2">
                      <Link to={crumb.to!}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-1.5">
        {/*
          Route-level loading. A spinner rather than a skeleton because loaders
          keep the PREVIOUS screen on-screen while they run: there is nothing to
          skeleton over, only a "this is stale" signal to give.
        */}
        {navigation.state === 'loading' && (
          <Loader2 className="size-3.5 animate-spin text-ink-3" aria-label="Loading" />
        )}

        {pendingCount > 0 && (
          <Link
            to="/approvals"
            className="inline-flex items-center gap-1.5 rounded-full bg-warn/15 px-2.5 py-1 text-xs font-medium text-warn-text transition-colors hover:bg-warn/25"
          >
            <span className="tabular-nums">{pendingCount}</span>
            <span className="hidden sm:inline">awaiting a decision</span>
          </Link>
        )}

        <ThemeToggle />
      </div>
    </header>
  );
}
