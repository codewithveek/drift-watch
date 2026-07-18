/** Small shared presentational primitives + formatting helpers. */
import type { ReactNode } from 'react';
import type { DriftSeverity } from './api.ts';

export function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const SEVERITY_CLASS: Record<DriftSeverity, string> = {
  none: 'bg-slate-700 text-slate-200',
  low: 'bg-sky-900 text-sky-200',
  medium: 'bg-amber-900 text-amber-200',
  high: 'bg-rose-900 text-rose-200',
};

export function SeverityBadge({ severity }: { severity: DriftSeverity }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[severity]}`}>
      {severity}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  const color =
    status === 'running' ? 'bg-emerald-500' : status === 'paused' ? 'bg-rose-500' : 'bg-amber-500';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

export function timeAgo(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
