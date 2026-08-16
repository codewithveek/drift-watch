/**
 * DriftWatch-specific display primitives.
 *
 * These are deliberately NOT replaced by shadcn equivalents: each encodes a
 * domain mapping (severity -> colour, agent status -> colour, risk -> level)
 * that is part of how operators read this product, not generic UI. The badges
 * are built ON shadcn's Badge so shape, typography and focus treatment stay
 * consistent with everything else; only the colour mapping is ours.
 *
 * Every tint here is the status fill at 15% over its surface, paired with the
 * matching `-text` tone — the combination scripts/contrast.mjs verifies, so a
 * pill can be reached for anywhere without re-checking it by eye.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { AgentStatus, DriftSeverity } from '@/api';
import type { RiskLevel } from '@/lib/risk';

/* ── Severity ─────────────────────────────────────────────────────────── */

const severityBadge = cva('border-transparent font-medium capitalize', {
  variants: {
    severity: {
      none: 'bg-panel-2 text-ink-3',
      low: 'bg-info/15 text-info-text',
      medium: 'bg-warn/15 text-warn-text',
      high: 'bg-danger/15 text-danger-text',
    },
  },
  defaultVariants: { severity: 'none' },
});

export function SeverityBadge({ severity }: { severity: DriftSeverity }) {
  return <Badge className={severityBadge({ severity })}>{severity}</Badge>;
}

/** Chart/legend fill for a severity, as a CSS value. */
export const SEVERITY_COLOR: Record<DriftSeverity, string> = {
  none: 'var(--line-2)',
  low: 'var(--info)',
  medium: 'var(--warn)',
  high: 'var(--danger)',
};

/* ── Risk ─────────────────────────────────────────────────────────────── */

const riskBadge = cva('border-transparent font-medium capitalize', {
  variants: {
    level: {
      low: 'bg-panel-2 text-ink-3',
      medium: 'bg-warn/15 text-warn-text',
      high: 'bg-danger/15 text-danger-text',
    },
  },
});

/**
 * Risk carries a dot at medium/high so the column is still scannable without
 * relying on the tint alone — the three levels differ in hue, and hue is the
 * first thing to go for a colour-blind operator.
 */
export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <Badge className={riskBadge({ level })}>
      {level !== 'low' && (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full"
          style={{ backgroundColor: level === 'high' ? 'var(--danger)' : 'var(--warn)' }}
        />
      )}
      {level}
    </Badge>
  );
}

/* ── Agent status ─────────────────────────────────────────────────────── */

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
    <span className="relative inline-flex size-2 shrink-0" aria-hidden="true">
      {ping && status === 'running' && (
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-[status-ping_1.8s_var(--ease-out-quint)_infinite]"
          style={{ backgroundColor: color }}
        />
      )}
      <span className="relative inline-flex size-2 rounded-full" style={{ backgroundColor: color }} />
    </span>
  );
}

/** Dot plus label, the pairing used wherever a status appears next to text. */
export function StatusLabel({ status, ping = false }: { status: AgentStatus; ping?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
      <StatusDot status={status} ping={ping} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/* ── Time ─────────────────────────────────────────────────────────────── */

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

/* ── Layout primitives ────────────────────────────────────────────────── */

/**
 * A section heading with optional trailing controls.
 *
 * The label is a plain heading, not a tracked uppercase eyebrow: on a surface
 * with this many labels already, another all-caps micro-line is noise, and it
 * would collide with the genuinely uppercase column headers below it.
 */
export function SectionHeading({
  title,
  description,
  children,
  as: Heading = 'h2',
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** The first section on a page owns the h1, so the document keeps one. */
  as?: 'h1' | 'h2';
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <Heading className="text-lg font-semibold tracking-tight text-ink">{title}</Heading>
        {description && <p className="mt-0.5 max-w-prose text-sm text-ink-3">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * One block in the operational-summary row.
 *
 * `footer` is the differentiator, not decoration: every tile answers "and what
 * about it?" in its own vocabulary — a status breakdown, a blocking-count pill,
 * a severity split. A row of tiles whose footers all said the same kind of
 * thing would be four copies of one card.
 */
export function MetricTile({
  label,
  value,
  footer,
  to,
  emphasis = 'neutral',
}: {
  label: string;
  value: ReactNode;
  footer?: ReactNode;
  /** Makes the whole tile a link. Tiles that lead somewhere lift on hover. */
  to?: string;
  /** Tints the value when the number itself is the alarm. */
  emphasis?: 'neutral' | 'warn' | 'danger';
}) {
  const body = (
    <CardContent className="px-5">
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <p
        className={cn(
          'mt-1.5 text-metric tabular-nums',
          emphasis === 'danger' ? 'text-danger-text' : emphasis === 'warn' ? 'text-warn-text' : 'text-ink',
        )}
      >
        {value}
      </p>
      {footer && <div className="mt-2 text-xs text-ink-3">{footer}</div>}
    </CardContent>
  );

  if (!to) return <Card className="gap-0 py-5">{body}</Card>;

  // The Link wraps the Card rather than using `asChild` — shadcn's Card is a
  // plain div with no Slot, so asChild would leak an unknown DOM prop.
  return (
    <Link to={to} className="rounded-xl">
      <Card className="lift h-full gap-0 py-5">{body}</Card>
    </Link>
  );
}

/**
 * Empty states teach the interface rather than announcing absence — per the
 * product register, "nothing here" is a wasted surface.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && (
        <div className="mb-1 grid size-10 place-items-center rounded-full bg-panel-2 text-ink-3">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <p className="max-w-sm text-xs text-ink-3">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A labelled metric. Tabular figures so values don't jitter as they poll. */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-medium tracking-wide text-ink-3 uppercase">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium tabular-nums text-ink">{value}</dd>
      {hint && <p className="text-2xs text-ink-3">{hint}</p>}
    </div>
  );
}

const NOTICE_TONES = {
  error: 'bg-danger/15 text-danger-text',
  success: 'bg-ok/15 text-ok-text',
  /** A standing condition worth knowing about, not a failure — e.g. an agent
   *  running under operator overrides rather than its own declared config. */
  warn: 'bg-warn/15 text-warn-text',
} as const;

/**
 * Inline notice. Shared so a failed action reads identically on every screen —
 * a "save failed" that looks different per page is one of the fastest ways to
 * make a tool feel unfinished.
 *
 * Only `error` gets role="alert": that interrupts a screen reader mid-sentence,
 * which is right for something that just went wrong and wrong for a state that
 * was already true when the page loaded.
 */
export function Notice({
  tone,
  children,
}: {
  tone: keyof typeof NOTICE_TONES;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('rounded-lg px-3 py-2 text-sm', NOTICE_TONES[tone])}
    >
      {children}
    </div>
  );
}
