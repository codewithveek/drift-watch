import { useState } from 'react';
import { KeyRound, LogOut, TriangleAlert, User } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { ChangePasswordDialog } from '@/components/change-password-dialog';
import { signOut, type SessionUser } from '@/lib/auth';

/**
 * Who you are signed in as, and the two things you can do about it.
 *
 * Replaces the old footer control, which reported whether an `AUTH_TOKEN` had
 * been pasted into this browser. That answered "is this tab configured"; this
 * answers "who am I", which is the question that matters once actions are
 * attributed to a person in the audit log.
 */
export function UserMenu({ user }: { user?: SessionUser }) {
  const [changingPassword, setChangingPassword] = useState(false);

  // Absent inside the root error boundary, which renders the same shell so a
  // failed load still has navigation.
  if (!user) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton className="text-ink-3" disabled>
            <User />
            <span>Not signed in</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  async function handleSignOut() {
    try {
      await signOut();
    } finally {
      // A full document load rather than a router navigation, and in `finally`
      // so a failed request still ends the session locally: the cookie is
      // httpOnly and the router holds loader data for a session that should no
      // longer be readable, so tearing the page down is the honest reset.
      window.location.assign('/login');
    }
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton className="text-ink-2">
                <User />
                <span className="truncate">{user.email}</span>
                {user.mustChangePassword && (
                  <TriangleAlert
                    className="ml-auto size-3.5 shrink-0 text-warn-text"
                    aria-label="Password change required"
                  />
                )}
              </SidebarMenuButton>
            </DropdownMenuTrigger>

            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <span className="block truncate text-sm text-ink">{user.name}</span>
                <span className="block truncate text-xs text-ink-3">{user.email}</span>
                {user.role && (
                  <span className="mt-1 block text-2xs uppercase tracking-wide text-ink-3">
                    {user.role}
                  </span>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setChangingPassword(true)}>
                <KeyRound className="size-3.5" />
                Change password
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleSignOut}>
                <LogOut className="size-3.5" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <ChangePasswordDialog
        open={changingPassword || user.mustChangePassword}
        // A seeded account cannot dismiss this. The password came from a
        // compose file — and therefore from shell history, a git repo and a CI
        // log — so "remind me later" is the wrong affordance to offer.
        dismissible={!user.mustChangePassword}
        onOpenChange={setChangingPassword}
      />
    </>
  );
}
