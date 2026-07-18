import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  client,
  getToken,
  setToken,
  type ActionLogEntry,
  type Approval,
  type DriftHistoryEntry,
  type StateResponse,
} from './api.ts';
import { Card, SeverityBadge, StatusDot, timeAgo } from './ui.tsx';

const POLL_MS = 4000;

export function App() {
  const [token, setTokenState] = useState(getToken());
  const [state, setState] = useState<StateResponse | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [drift, setDrift] = useState<DriftHistoryEntry[]>([]);
  const [log, setLog] = useState<ActionLogEntry[]>([]);
  const [error, setError] = useState<string>('');

  const refresh = useCallback(async () => {
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
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const onResolve = async (id: string, decision: 'approved' | 'rejected') => {
    await client.resolveApproval(id, decision).catch((e) => setError((e as Error).message));
    await refresh();
  };
  const onControl = async (action: 'pause' | 'resume' | 'rollback') => {
    await client.control(action).catch((e) => setError((e as Error).message));
    await refresh();
  };
  const onScan = async () => {
    await client.scan().catch((e) => setError((e as Error).message));
    await refresh();
  };

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-100">DriftWatch Autopilot</h1>
          <p className="text-sm text-slate-400">Perceive → reason → act, with a human in the loop.</p>
        </div>
        <TokenField
          token={token}
          onSave={(t) => {
            setToken(t);
            setTokenState(t);
            void refresh();
          }}
        />
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-800 bg-rose-950/60 px-4 py-2 text-sm text-rose-200">
          {error}
        </div>
      )}

      <HealthStrip state={state} onControl={onControl} onScan={onScan} />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ApprovalsQueue approvals={approvals} onResolve={onResolve} />
        <DriftFeed drift={drift} />
      </div>

      <div className="mt-6">
        <ActionLogView log={log} />
      </div>
    </div>
  );
}

function TokenField({ token, onSave }: { token: string; onSave: (t: string) => void }) {
  const [value, setValue] = useState(token);
  return (
    <div className="flex items-center gap-2">
      <input
        type="password"
        value={value}
        placeholder="Bearer token"
        onChange={(e) => setValue(e.target.value)}
        className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-600"
      />
      <button
        onClick={() => onSave(value)}
        className="rounded-lg bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600"
      >
        Save
      </button>
    </div>
  );
}

function HealthStrip({
  state,
  onControl,
  onScan,
}: {
  state: StateResponse | null;
  onControl: (a: 'pause' | 'resume' | 'rollback') => void;
  onScan: () => void;
}) {
  return (
    <Card
      title="Agent health"
      action={
        <div className="flex gap-2">
          <ControlButton label="Pause" onClick={() => onControl('pause')} tone="rose" />
          <ControlButton label="Resume" onClick={() => onControl('resume')} tone="emerald" />
          <ControlButton label="Rollback" onClick={() => onControl('rollback')} tone="amber" />
          <ControlButton label="Scan now" onClick={onScan} tone="sky" />
        </div>
      }
    >
      {!state ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <Stat label="Status">
            <span className="flex items-center gap-2 capitalize">
              <StatusDot status={state.agent.status} /> {state.agent.status}
            </span>
          </Stat>
          <Stat label="Active version">v{state.agent.activeVersion}</Stat>
          <Stat label="Autopilot">
            {state.autopilot.enabled ? `${state.autopilot.mode}` : 'disabled'}
          </Stat>
          <Stat label="Token budget / task">
            {state.guardrails.maxTokensPerTask || '∞'}
          </Stat>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 font-medium text-slate-100">{children}</div>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  tone,
}: {
  label: string;
  onClick: () => void;
  tone: 'rose' | 'emerald' | 'amber' | 'sky';
}) {
  const tones = {
    rose: 'bg-rose-700 hover:bg-rose-600',
    emerald: 'bg-emerald-700 hover:bg-emerald-600',
    amber: 'bg-amber-700 hover:bg-amber-600',
    sky: 'bg-sky-700 hover:bg-sky-600',
  } as const;
  return (
    <button onClick={onClick} className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white ${tones[tone]}`}>
      {label}
    </button>
  );
}

function ApprovalsQueue({
  approvals,
  onResolve,
}: {
  approvals: Approval[];
  onResolve: (id: string, decision: 'approved' | 'rejected') => void;
}) {
  return (
    <Card title={`Pending approvals (${approvals.length})`}>
      {approvals.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing awaiting a decision.</p>
      ) : (
        <ul className="space-y-3">
          {approvals.map((a) => (
            <li key={a.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm text-slate-100">{a.action}</span>
                <SeverityBadge severity={a.severity} />
              </div>
              <p className="mt-1 text-xs text-slate-400">{a.reasons.join('; ') || a.recommendedAction}</p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => onResolve(a.id, 'approved')}
                  className="rounded-lg bg-emerald-700 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-600"
                >
                  ✅ Approve
                </button>
                <button
                  onClick={() => onResolve(a.id, 'rejected')}
                  className="rounded-lg bg-rose-700 px-3 py-1 text-sm font-medium text-white hover:bg-rose-600"
                >
                  ❌ Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DriftFeed({ drift }: { drift: DriftHistoryEntry[] }) {
  return (
    <Card title="Drift verdicts">
      {drift.length === 0 ? (
        <p className="text-sm text-slate-500">No verdicts recorded yet.</p>
      ) : (
        <ul className="space-y-2">
          {drift.slice(0, 12).map((d) => (
            <li key={d.id} className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2 text-sm">
              <div>
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={d.severity} />
                  <span className={d.drift ? 'text-rose-300' : 'text-slate-400'}>
                    {d.drift ? 'drift' : 'stable'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-400">{d.reasons.join('; ') || d.recommendedAction}</p>
              </div>
              <span className="whitespace-nowrap text-xs text-slate-500">{timeAgo(d.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ActionLogView({ log }: { log: ActionLogEntry[] }) {
  return (
    <Card title="Action / audit log">
      {log.length === 0 ? (
        <p className="text-sm text-slate-500">No actions taken yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="pb-2">When</th>
              <th className="pb-2">Action</th>
              <th className="pb-2">Outcome</th>
              <th className="pb-2">Actor</th>
              <th className="pb-2">Channel</th>
            </tr>
          </thead>
          <tbody>
            {log.slice(0, 20).map((e) => (
              <tr key={e.id} className="border-t border-slate-800">
                <td className="py-1.5 text-slate-500">{timeAgo(e.at)}</td>
                <td className="py-1.5 font-mono text-slate-200">{e.action}</td>
                <td className="py-1.5 text-slate-300">{e.outcome}</td>
                <td className="py-1.5 text-slate-400">{e.actor ?? '—'}</td>
                <td className="py-1.5 text-slate-400">{e.channel ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
