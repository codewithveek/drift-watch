/** Shared presentational primitives + formatting helpers for the console. */
import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';
import type { AgentStatus, DriftSeverity } from './api.ts';

/* ------------------------------------------------------------------ icons -- */
/* One consistent stroke-icon vocabulary (1.75 stroke, rounded) — no emoji. */

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={16}
      height={16}
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  Check: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  ),
  X: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  ),
  Pause: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M8 5v14M16 5v14" />
    </Icon>
  ),
  Play: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="m7 4 13 8-13 8V4z" />
    </Icon>
  ),
  Rollback: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.7 3L3 13" />
    </Icon>
  ),
  Scan: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </Icon>
  ),
  Key: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 8.3-8.3M17 6l2 2M15 8l1.5 1.5" />
    </Icon>
  ),
  Alert: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Icon>
  ),
  Inbox: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" />
    </Icon>
  ),
  Pulse: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M3 12h4l3 8 4-16 3 8h4" />
    </Icon>
  ),
  History: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l3 2" />
    </Icon>
  ),
};

/* ---------------------------------------------------------------- spinner -- */

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      className={`animate-spin ${className}`}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/* ----------------------------------------------------------------- button -- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'default' | 'ghost' | 'danger' | 'success';
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
};

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap ' +
  'transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-bright)]';

const BUTTON_VARIANT = {
  primary: 'bg-accent text-white hover:bg-accent-hover shadow-sm shadow-black/20',
  default: 'bg-panel-2 text-ink-2 ring-1 ring-inset ring-line hover:bg-line hover:text-ink',
  ghost: 'text-ink-2 hover:bg-panel-2 hover:text-ink',
  danger: 'text-danger-text ring-1 ring-inset ring-danger/35 hover:bg-danger/15',
  success: 'text-ok-text ring-1 ring-inset ring-ok/35 hover:bg-ok/15',
} as const;

const BUTTON_SIZE = {
  sm: 'h-8 px-2.5 text-[13px]',
  md: 'h-9 px-3.5 text-sm',
} as const;

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  icon,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- card -- */

export function Card({
  title,
  icon,
  action,
  children,
  className = '',
}: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-line bg-panel/70 shadow-sm shadow-black/20 backdrop-blur-sm ${className}`}
    >
      <header className="flex min-h-[3.25rem] flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
        <h2 className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-ink">
          {icon && <span className="text-ink-3">{icon}</span>}
          {title}
        </h2>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------ empty state -- */

export function EmptyState({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-panel-2 text-ink-3">
        {icon}
      </span>
      <p className="max-w-[42ch] text-sm text-ink-3">{children}</p>
    </div>
  );
}

/* -------------------------------------------------------------- skeleton --- */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} />;
}

/* ---------------------------------------------------------------- badges --- */

const SEVERITY_CLASS: Record<DriftSeverity, string> = {
  none: 'bg-panel-2 text-ink-3 ring-line',
  low: 'bg-info/12 text-info-text ring-info/25',
  medium: 'bg-warn/12 text-warn-text ring-warn/25',
  high: 'bg-danger/15 text-danger-text ring-danger/30',
};

export function SeverityBadge({ severity }: { severity: DriftSeverity }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${SEVERITY_CLASS[severity]}`}
    >
      {severity}
    </span>
  );
}

/* ----------------------------------------------------------- status dots --- */

const STATUS_COLOR: Record<AgentStatus, string> = {
  running: 'var(--color-ok)',
  paused: 'var(--color-danger)',
  throttled: 'var(--color-warn)',
};

export function StatusDot({ status, ping = false }: { status: AgentStatus; ping?: boolean }) {
  const color = STATUS_COLOR[status] ?? 'var(--color-warn)';
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
      {ping && status === 'running' && (
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:[animation:status-ping_1.8s_var(--ease-out-quint)_infinite]"
          style={{ backgroundColor: color }}
        />
      )}
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
    </span>
  );
}

/* ------------------------------------------------------------- formatting -- */

export function timeAgo(ms: number, now: number = Date.now()): string {
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
