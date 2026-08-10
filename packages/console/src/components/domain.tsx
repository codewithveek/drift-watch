/**
 * DriftWatch-specific display primitives.
 *
 * These are deliberately NOT replaced by shadcn equivalents: each encodes a
 * domain mapping (severity -> colour, agent status -> colour) that is part of
 * how operators read this product, not generic UI. SeverityBadge is built on
 * shadcn's Badge so the shape/typography stay consistent with everything else;
 * only the colour mapping is ours.
 */
import type { ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { AgentStatus, DriftSeverity } from '@/api';

const severityBadge = cva('border-transparent font-medium', {
  variants: {
    severity: {
      none: 'bg-panel-2 text-ink-3',
      low: 'bg-info/12 text-info-text',
      medium: 'bg-warn/12 text-warn-text',
      high: 'bg-danger/15 text-danger-text',
    },
  },
  defaultVariants: { severity: 'none' },
});

export function SeverityBadge({ severity }: { severity: DriftSeverity }) {
  return <Badge className={severityBadge({ severity })}>{severity}</Badge>;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  running: 'var(--ok)',
  paused: 'var(--danger)',
  throttled: 'var(--warn)',
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  throttled: 'Throttled',
};

/** A live status dot. The ping ring only animates for a healthy, running agent. */
export function StatusDot({ status, ping = false }: { status: AgentStatus; ping?: boolean }) {
  const color = STATUS_COLOR[status] ?? 'var(--warn)';
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
      {ping && status === 'running' && (
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:[animation:status-ping_1.8s_var(--ease-out-quint)_infinite]"
          style={{ backgroundColor: color }}
        />
      )}
      <span
        className="relative inline-flex h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}

/** Compact relative time. Absolute dates aren't useful at ops glance-speed. */
export function timeAgo(ms: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Countdown against a deadline — used where an approval is holding a request open. */
export function timeUntil(ms: number, now: number = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000);
  if (seconds <= 0) return 'expired';
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s left`;
}

/**
 * Empty states teach the interface rather than announcing absence — per the
 * product register, "nothing here" is a wasted surface.
 */
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-ink-3">{icon}</div>}
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {children && <p className="max-w-sm text-xs text-ink-3">{children}</p>}
    </div>
  );
}

/** A labelled metric. Tabular figures so values don't jitter as they poll. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-medium uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-sm font-medium text-ink', 'tabular-nums')}>
        {value}
      </dd>
      {hint && <p className="text-2xs text-ink-3">{hint}</p>}
    </div>
  );
}
