import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  client,
  getToken,
  setToken,
  type ActionLogEntry,
  type AgentStatus,
  type Approval,
  type DriftHistoryEntry,
  type StateResponse,
} from './api.ts';
import {
  Button,
  Card,
  EmptyState,
  Icons,
  SeverityBadge,
  Skeleton,
  Spinner,
  StatusDot,
  timeAgo,
} from './ui.tsx';

const POLL_MS = 4000;

const STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  throttled: 'Throttled',
};

export function App() {
  const [token, setTokenState] = useState(getToken());
  const [state, setState] = useState<StateResponse | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [drift, setDrift] = useState<DriftHistoryEntry[]>([]);
  const [log, setLog] = useState<ActionLogEntry[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);
  const [pendingControl, setPendingControl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, a, d, l] = await Promise.all([
        client.getState(),
        client.getApprovals(),
        client.getDriftHistory(),
        client.getActionLog(),
      ]);
      setState(s);
      setApprovals(a.approvals);
      setDrift(d.history);
      setLog(l.log);
      setError('');
      setLastSyncAt(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Keep relative timestamps ("3s ago") live between polls.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const onResolve = async (id: string, decision: 'approved' | 'rejected') => {
    setPendingApproval(id);
    try {
      await client.resolveApproval(id, decision);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingApproval(null);
    }
  };

  const onControl = async (action: 'pause' | 'resume' | 'rollback') => {
    setPendingControl(action);
    try {
      await client.control(action);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingControl(null);
    }
  };

  const onScan = async () => {
    setPendingControl('scan');
    try {
      await client.scan();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingControl(null);
    }
  };

  return (
    <div className="min-h-screen">
      <TopBar
        state={state}
        token={token}
        refreshing={refreshing}
        lastSyncAt={lastSyncAt}
        now={now}
        onSaveToken={(t) => {
          setToken(t);
          setTokenState(t);
          void refresh();
        }}
      />

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

        <ControlDeck
          state={state}
          loaded={loaded}
          pendingControl={pendingControl}
          onControl={onControl}
          onScan={onScan}
        />

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <ApprovalsQueue
            approvals={approvals}
            loaded={loaded}
            pendingApproval={pendingApproval}
            onResolve={onResolve}
          />
          <DriftFeed drift={drift} loaded={loaded} now={now} />
        </div>

        <div className="mt-5">
          <ActionLogView log={log} loaded={loaded} now={now} />
        </div>
      </main>
    </div>
  );
}

/* -------------------------------------------------------------- top bar --- */

function TopBar({
  state,
  token,
  refreshing,
  lastSyncAt,
  now,
  onSaveToken,
}: {
  state: StateResponse | null;
  token: string;
  refreshing: boolean;
  lastSyncAt: number | null;
  now: number;
  onSaveToken: (t: string) => void;
}) {
  return (
    <header className="sticky top-0 z-[var(--z-sticky)] border-b border-line bg-canvas/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent-bright ring-1 ring-inset ring-accent/25"
            aria-hidden="true"
          >
            <Icons.Pulse width={18} height={18} />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-ink">DriftWatch</div>
            <div className="text-xs text-ink-3">Autopilot control</div>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {state && (
            <span className="hidden items-center gap-2 rounded-lg bg-panel px-2.5 py-1.5 text-sm font-medium text-ink-2 ring-1 ring-inset ring-line sm:inline-flex">
              <StatusDot status={state.agent.status} ping />
              {STATUS_LABEL[state.agent.status] ?? state.agent.status}
            </span>
          )}
          <SyncIndicator refreshing={refreshing} lastSyncAt={lastSyncAt} now={now} />
          <ConnectionButton token={token} onSaveToken={onSaveToken} />
        </div>
      </div>
    </header>
  );
}

function SyncIndicator({
  refreshing,
  lastSyncAt,
  now,
}: {
  refreshing: boolean;
  lastSyncAt: number | null;
  now: number;
}) {
  const seconds = lastSyncAt ? Math.round((now - lastSyncAt) / 1000) : null;
  const label = refreshing
    ? 'Syncing…'
    : seconds === null
      ? 'Connecting…'
      : seconds < 5
        ? 'Synced just now'
        : `Synced ${seconds}s ago`;
  return (
    <span
      className="hidden items-center gap-1.5 text-xs text-ink-3 md:inline-flex"
      aria-live="polite"
      title="Live data refreshes every few seconds"
    >
      {refreshing ? (
        <Spinner className="text-accent-bright" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

function ConnectionButton({ token, onSaveToken }: { token: string; onSaveToken: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(token);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setValue(token), [token]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const connected = token.length > 0;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-panel px-2.5 text-sm font-medium text-ink-2 ring-1 ring-inset ring-line transition-colors hover:bg-panel-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-bright)]"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icons.Key className={connected ? 'text-ok-text' : 'text-warn-text'} />
        <span className="hidden sm:inline">{connected ? 'Connected' : 'Set token'}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="API token"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-[var(--z-popover)] w-72 rounded-xl border border-line bg-panel p-3 shadow-xl shadow-black/40"
        >
          <label htmlFor="token-input" className="mb-1.5 block text-xs font-medium text-ink-2">
            Bearer token
          </label>
          <input
            id="token-input"
            ref={inputRef}
            type="password"
            value={value}
            placeholder="Paste API token"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onSaveToken(value);
                setOpen(false);
              }
            }}
            className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-accent"
          />
          <p className="mt-1.5 text-xs text-ink-3">Stored locally; sent as a bearer header with each request.</p>
          <div className="mt-2.5 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onSaveToken(value);
                setOpen(false);
              }}
            >
              Save token
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- banners --- */

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="mb-5 flex items-start gap-2.5 rounded-lg border border-danger/40 bg-danger/12 px-3.5 py-2.5 text-sm text-danger-text"
    >
      <Icons.Alert className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="-m-1 rounded p-1 text-danger-text/70 transition-colors hover:text-danger-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent-bright)]"
      >
        <Icons.X width={15} height={15} />
      </button>
    </div>
  );
}

/* --------------------------------------------------------- control deck --- */

function ControlDeck({
  state,
  loaded,
  pendingControl,
  onControl,
  onScan,
}: {
  state: StateResponse | null;
  loaded: boolean;
  pendingControl: string | null;
  onControl: (a: 'pause' | 'resume' | 'rollback') => void;
  onScan: () => void;
}) {
  const [confirmRollback, setConfirmRollback] = useState(false);
  const busy = pendingControl !== null;
  const running = state?.agent.status === 'running';

  return (
    <Card
      title="Agent health"
      icon={<Icons.Pulse />}
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {confirmRollback ? (
            <>
              <span className="text-xs text-ink-2">Roll back to previous version?</span>
              <Button
                size="sm"
                variant="danger"
                loading={pendingControl === 'rollback'}
                onClick={() => {
                  onControl('rollback');
                  setConfirmRollback(false);
                }}
              >
                Confirm
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRollback(false)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {running ? (
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Icons.Pause />}
                  loading={pendingControl === 'pause'}
                  disabled={busy || !state}
                  onClick={() => onControl('pause')}
                >
                  Pause
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="success"
                  icon={<Icons.Play />}
                  loading={pendingControl === 'resume'}
                  disabled={busy || !state}
                  onClick={() => onControl('resume')}
                >
                  Resume
                </Button>
              )}
              <Button
                size="sm"
                variant="default"
                icon={<Icons.Rollback />}
                disabled={busy || !state}
                onClick={() => setConfirmRollback(true)}
              >
                Rollback
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<Icons.Scan />}
                loading={pendingControl === 'scan'}
                disabled={busy}
                onClick={onScan}
              >
                Scan now
              </Button>
            </>
          )}
        </div>
      }
    >
      {!loaded && !state ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-5 w-28" />
            </div>
          ))}
        </div>
      ) : !state ? (
        <EmptyState icon={<Icons.Alert />}>Agent state is unavailable. Check your token and connection.</EmptyState>
      ) : (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4 md:divide-x md:divide-line">
          <Stat label="Status" className="md:pl-0">
            <span className="flex items-center gap-2">
              <StatusDot status={state.agent.status} ping />
              {STATUS_LABEL[state.agent.status] ?? state.agent.status}
            </span>
          </Stat>
          <Stat label="Active version" className="md:pl-6">
            <span className="tabular-nums">v{state.agent.activeVersion}</span>
          </Stat>
          <Stat label="Autopilot" className="md:pl-6">
            {state.autopilot.enabled ? (
              <span className="capitalize">{state.autopilot.mode}</span>
            ) : (
              <span className="text-ink-3">Disabled</span>
            )}
          </Stat>
          <Stat label="Token budget / task" className="md:pl-6">
            <span className="tabular-nums">{state.guardrails.maxTokensPerTask || '∞'}</span>
          </Stat>
        </dl>
      )}
    </Card>
  );
}

function Stat({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-ink-3">{label}</dt>
      <dd className="mt-1 text-[15px] font-medium text-ink">{children}</dd>
    </div>
  );
}

/* ------------------------------------------------------ approvals queue --- */

function ApprovalsQueue({
  approvals,
  loaded,
  pendingApproval,
  onResolve,
}: {
  approvals: Approval[];
  loaded: boolean;
  pendingApproval: string | null;
  onResolve: (id: string, decision: 'approved' | 'rejected') => void;
}) {
  return (
    <Card
      title="Pending approvals"
      icon={<Icons.Inbox />}
      action={
        approvals.length > 0 ? (
          <span className="rounded-md bg-accent/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-accent-bright ring-1 ring-inset ring-accent/25">
            {approvals.length}
          </span>
        ) : undefined
      }
    >
      {!loaded ? (
        <ul className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <li key={i} className="rounded-lg border border-line bg-canvas/40 p-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-2 h-3 w-full" />
              <Skeleton className="mt-3 h-8 w-32" />
            </li>
          ))}
        </ul>
      ) : approvals.length === 0 ? (
        <EmptyState icon={<Icons.Check width={18} height={18} />}>
          Queue is clear. New decisions from the agent will appear here for your review.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {approvals.map((a) => {
            const busy = pendingApproval === a.id;
            return (
              <li key={a.id} className="rounded-lg border border-line bg-canvas/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <code className="min-w-0 truncate font-mono text-sm text-ink">{a.action}</code>
                  <SeverityBadge severity={a.severity} />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
                  {a.reasons.join('; ') || a.recommendedAction}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="success"
                    icon={<Icons.Check width={15} height={15} />}
                    loading={busy}
                    disabled={pendingApproval !== null}
                    onClick={() => onResolve(a.id, 'approved')}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Icons.X width={15} height={15} />}
                    disabled={pendingApproval !== null}
                    onClick={() => onResolve(a.id, 'rejected')}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ drift feed --- */

function DriftFeed({ drift, loaded, now }: { drift: DriftHistoryEntry[]; loaded: boolean; now: number }) {
  return (
    <Card title="Drift verdicts" icon={<Icons.Pulse />}>
      {!loaded ? (
        <ul className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <li key={i} className="flex items-center justify-between gap-3 pb-3">
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-3/4" />
              </div>
              <Skeleton className="h-3 w-12" />
            </li>
          ))}
        </ul>
      ) : drift.length === 0 ? (
        <EmptyState icon={<Icons.Pulse width={18} height={18} />}>
          No verdicts recorded yet. Run a scan to evaluate the agent for drift.
        </EmptyState>
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {drift.slice(0, 12).map((d) => (
            <li key={d.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={d.severity} />
                  <span
                    className={`text-xs font-medium ${d.drift ? 'text-danger-text' : 'text-ink-3'}`}
                  >
                    {d.drift ? 'Drift detected' : 'Stable'}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-ink-2" title={d.reasons.join('; ') || d.recommendedAction}>
                  {d.reasons.join('; ') || d.recommendedAction}
                </p>
              </div>
              <time
                className="shrink-0 whitespace-nowrap text-xs tabular-nums text-ink-3"
                dateTime={new Date(d.at).toISOString()}
                title={new Date(d.at).toLocaleString()}
              >
                {timeAgo(d.at, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ action log --- */

function ActionLogView({ log, loaded, now }: { log: ActionLogEntry[]; loaded: boolean; now: number }) {
  return (
    <Card title="Action & audit log" icon={<Icons.History />}>
      {!loaded ? (
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : log.length === 0 ? (
        <EmptyState icon={<Icons.History width={18} height={18} />}>
          No actions taken yet. Approvals, control changes, and notifications are recorded here.
        </EmptyState>
      ) : (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead>
              <tr className="text-xs font-medium text-ink-3">
                <th scope="col" className="px-4 pb-2 font-medium">When</th>
                <th scope="col" className="px-4 pb-2 font-medium">Action</th>
                <th scope="col" className="px-4 pb-2 font-medium">Outcome</th>
                <th scope="col" className="px-4 pb-2 font-medium">Actor</th>
                <th scope="col" className="px-4 pb-2 font-medium">Channel</th>
              </tr>
            </thead>
            <tbody>
              {log.slice(0, 20).map((e) => (
                <tr key={e.id} className="border-t border-line transition-colors hover:bg-panel-2/50">
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-ink-3">{timeAgo(e.at, now)}</td>
                  <td className="px-4 py-2 font-mono text-ink">{e.action}</td>
                  <td className="px-4 py-2 text-ink-2">{e.outcome}</td>
                  <td className="px-4 py-2 text-ink-3">{e.actor ?? '—'}</td>
                  <td className="px-4 py-2 text-ink-3">{e.channel ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
