import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useRevalidator } from 'react-router';
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleDot,
  ShieldAlert,
  Timer,
  X,
} from 'lucide-react';
import { client, type Approval, type ToolCallApproval } from '@/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Notice, SeverityBadge, StatusDot, timeAgo, timeUntil } from '@/components/domain';
import { cn } from '@/lib/utils';
import { queueItemKey, type QueueItem } from '@/lib/queue';

/** Re-renders on a 1s tick so the countdowns below actually count down. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const isToolCall = (entry: QueueItem): entry is Extract<QueueItem, { kind: 'toolCall' }> =>
  entry.kind === 'toolCall';

const entryTitle = (entry: QueueItem) =>
  isToolCall(entry) ? entry.item.tool : entry.item.action.replace(/_/g, ' ');

const entrySeverity = (entry: QueueItem) =>
  isToolCall(entry) ? undefined : entry.item.severity;

/* ── Queue ────────────────────────────────────────────────────────────── */

/**
 * The decision queue and its review panel.
 *
 * Rows are summary-only and open a Sheet for the full context. That split is
 * deliberate: a queue you can scan tells you how much work there is, and the
 * panel tells you what one item means — cramming the policy match, the payload
 * and the timeline into every row (which is what this replaced) makes a queue
 * of three items look like a queue of thirty.
 */
export function ApprovalQueue({
  entries,
  showAgent = true,
  emptyState,
}: {
  entries: QueueItem[];
  /** Off on a single agent's own page, where every row would repeat its name. */
  showAgent?: boolean;
  emptyState: ReactNode;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const now = useNow();

  if (entries.length === 0) return <Card className="py-0">{emptyState}</Card>;

  const selected = entries.find((entry) => queueItemKey(entry) === openKey) ?? null;

  return (
    <>
      <Card className="gap-0 overflow-hidden py-0">
        <ul className="divide-y divide-line">
          {entries.map((entry, index) => {
            const expired = entry.item.expiresAt <= now;
            const severity = entrySeverity(entry);
            return (
              <li
                key={queueItemKey(entry)}
                className="motion-safe:animate-[queue-in_260ms_var(--ease-out-quint)_both]"
                // Staggered only across the items of THIS list, and only far
                // enough to read as arrival order rather than choreography.
                style={{ animationDelay: `${Math.min(index, 6) * 35}ms` }}
              >
                <button
                  type="button"
                  onClick={() => setOpenKey(queueItemKey(entry))}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-panel-2/70"
                >
                  <span
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-lg',
                      isToolCall(entry) ? 'bg-warn/15 text-warn-text' : 'bg-info/15 text-info-text',
                    )}
                  >
                    {isToolCall(entry) ? (
                      <Timer className="size-4" />
                    ) : (
                      <ShieldAlert className="size-4" />
                    )}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-sm font-medium text-ink">
                        {entryTitle(entry)}
                      </span>
                      {severity && <SeverityBadge severity={severity} />}
                      {isToolCall(entry) && (
                        <Badge className="border-transparent bg-panel-2 font-medium text-ink-3">
                          blocking a live request
                        </Badge>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-ink-3">
                      {showAgent && <span className="text-ink-2">{entry.agent.name}</span>}
                      {showAgent && ' · '}
                      {isToolCall(entry)
                        ? (entry.item.matchedReason ?? 'Matched a tool-call policy')
                        : (entry.item.reasons[0] ?? entry.item.recommendedAction)}
                    </span>
                  </span>

                  <span
                    className={cn(
                      'shrink-0 text-2xs font-medium tabular-nums',
                      expired ? 'text-ink-3' : 'text-warn-text',
                    )}
                  >
                    {expired ? 'timed out' : timeUntil(entry.item.expiresAt, now)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      <ReviewSheet
        entry={selected}
        now={now}
        onOpenChange={(open) => !open && setOpenKey(null)}
      />
    </>
  );
}

/* ── Review panel ─────────────────────────────────────────────────────── */

function ReviewSheet({
  entry,
  now,
  onOpenChange,
}: {
  entry: QueueItem | null;
  now: number;
  onOpenChange: (open: boolean) => void;
}) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = entry ? queueItemKey(entry) : null;

  // Clearing on entry change stops a failure from one item bleeding into the
  // next one an operator opens.
  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [key]);

  /*
   * The panel keeps rendering the item it was closed on. Radix animates the
   * sheet out over 300ms; without this the content would unmount on the first
   * frame of that animation and the panel would visibly empty itself before
   * sliding away.
   */
  const lastEntry = useRef<QueueItem | null>(null);
  if (entry) lastEntry.current = entry;
  const shown = entry ?? lastEntry.current;

  if (!shown) return null;

  const expired = shown.item.expiresAt <= now;

  async function decide(decision: 'approved' | 'rejected') {
    if (!entry) return;
    setBusy(true);
    setError(null);
    try {
      if (entry.kind === 'toolCall') {
        await client.resolveToolCall(entry.agent.id, entry.item.id, decision);
      } else {
        await client.resolveApproval(entry.agent.id, entry.item.id, decision);
      }
      onOpenChange(false);
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to resolve');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={entry !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <SheetHeader className="gap-2 border-b border-line px-5 pt-5 pb-4">
          <SheetTitle className="pr-8 font-mono text-lg tracking-tight">
            {entryTitle(shown)}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {shown.kind === 'toolCall'
              ? 'Gated before execution by a tool-call policy'
              : 'Proposed by Autopilot after a drift verdict'}
          </SheetDescription>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Link to={`/agents/${shown.agent.id}`} className="rounded-full">
              <Badge className="gap-1.5 border-transparent bg-panel-2 font-medium text-ink-2 hover:bg-line/60">
                <StatusDot status={shown.agent.status} />
                {shown.agent.name}
                <ArrowUpRight className="size-3" />
              </Badge>
            </Link>
            {shown.kind === 'approval' && <SeverityBadge severity={shown.item.severity} />}
            {shown.kind === 'toolCall' && shown.item.fieldPath && (
              <Badge className="border-transparent bg-panel-2 font-mono font-medium text-ink-2">
                {shown.item.fieldPath}
              </Badge>
            )}
          </div>
        </SheetHeader>

        <div className="space-y-6 px-5 py-5">
          {error && <Notice tone="error">{error}</Notice>}

          {shown.kind === 'toolCall' ? (
            <ToolCallDetail toolCall={shown.item} now={now} expired={expired} />
          ) : (
            <ControlActionDetail approval={shown.item} now={now} />
          )}

          <Timeline entry={shown} now={now} expired={expired} />
        </div>

        <SheetFooter className="sticky bottom-0 gap-2 border-t border-line bg-panel px-5 py-4">
          {expired ? (
            <p className="text-xs text-ink-3">
              This request already timed out — the agent received the server's configured timeout
              decision, so approving or rejecting it now would change nothing.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => decide('approved')}>
                <Check className="size-3.5" />
                Approve
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => decide('rejected')}>
                <X className="size-3.5" />
                Reject
              </Button>
              <SheetClose asChild>
                <Button variant="ghost" disabled={busy}>
                  Decide later
                </Button>
              </SheetClose>
            </div>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Three facts about the match, sized so the whole row reads at a glance. */
function MatchFacts({ facts }: { facts: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-3 gap-2">
      {facts.map((fact) => (
        <div key={fact.label} className="rounded-lg border border-line bg-panel px-3 py-2">
          {/*
            Wraps rather than truncates. The middle fact is usually a dot-path
            field name (`customer.ssn`), and a truncated field name is the one
            piece of this panel an approver cannot afford to guess at.
          */}
          <dd className="text-sm font-semibold tabular-nums wrap-break-word text-ink sm:text-base">
            {fact.value}
          </dd>
          <dt className="mt-0.5 text-2xs leading-tight text-ink-3">{fact.label}</dt>
        </div>
      ))}
    </dl>
  );
}

function ToolCallDetail({
  toolCall,
  now,
  expired,
}: {
  toolCall: ToolCallApproval;
  now: number;
  expired: boolean;
}) {
  const payloadKeys = toolCall.inputSummary ? Object.keys(toolCall.inputSummary) : null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-ink">Why it stopped</h3>

      <div className="space-y-3 rounded-xl bg-panel-2/70 p-3">
        <div className="flex gap-2.5">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn-text" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-ink">
              {toolCall.fieldPath
                ? `A rule on ${toolCall.fieldPath} matched`
                : 'A rule for this tool matched'}
            </p>
            <p className="text-xs text-ink-2">
              {toolCall.matchedReason ??
                'The policy requires a human decision before this call may run.'}
            </p>
          </div>
        </div>

        <MatchFacts
          facts={[
            {
              label: payloadKeys ? 'fields in payload' : 'payload not captured',
              value: payloadKeys ? payloadKeys.length : '—',
            },
            { label: 'matched on', value: toolCall.fieldPath ?? 'whole tool' },
            {
              label: expired ? 'timed out' : 'until timeout',
              value: expired ? '0s' : timeUntil(toolCall.expiresAt, now).replace(' left', ''),
            },
          ]}
        />
      </div>

      <div>
        <h4 className="mb-1.5 text-xs font-medium text-ink-2">Call arguments</h4>
        {payloadKeys ? (
          <pre className="max-h-56 overflow-auto rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-2xs leading-relaxed text-ink-2">
            {JSON.stringify(toolCall.inputSummary, null, 2)}
          </pre>
        ) : (
          <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-3">
            Payload capture is off, so the arguments were never sent to the control plane. That is
            the safe default — a gated field's value would otherwise be copied into every approval
            notification. Turn capture on if you need to review values here.
          </p>
        )}
      </div>
    </section>
  );
}

function ControlActionDetail({ approval, now }: { approval: Approval; now: number }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-ink">Why it was proposed</h3>

      <div className="space-y-3 rounded-xl bg-panel-2/70 p-3">
        {approval.reasons.length > 0 ? (
          <ul className="space-y-1.5">
            {approval.reasons.map((reason, index) => (
              <li key={index} className="flex gap-2 text-xs text-ink-2">
                <CircleDot className="mt-0.5 size-3 shrink-0 text-ink-3" />
                {reason}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">No reasons were recorded with this verdict.</p>
        )}

        <MatchFacts
          facts={[
            { label: 'proposed action', value: approval.action.replace(/_/g, ' ') },
            { label: 'severity', value: approval.severity },
            { label: 'until timeout', value: timeUntil(approval.expiresAt, now).replace(' left', '') },
          ]}
        />
      </div>

      {approval.recommendedAction && approval.recommendedAction !== 'none' && (
        <p className="text-xs text-ink-2">
          <span className="font-medium text-ink">Recommended:</span> {approval.recommendedAction}
        </p>
      )}
    </section>
  );
}

/* ── Timeline ─────────────────────────────────────────────────────────── */

interface Step {
  label: string;
  meta?: string;
  state: 'done' | 'current' | 'failed';
}

function Timeline({ entry, now, expired }: { entry: QueueItem; now: number; expired: boolean }) {
  const steps: Step[] =
    entry.kind === 'toolCall'
      ? [
          {
            label: `${entry.item.tool} called`,
            meta: timeAgo(entry.item.createdAt, now),
            state: 'done',
          },
          {
            label: entry.item.fieldPath
              ? `Policy matched on ${entry.item.fieldPath}`
              : 'Policy matched for this tool',
            state: 'done',
          },
          {
            label: expired ? 'Timed out — the agent already got its answer' : 'Awaiting your decision',
            meta: expired ? undefined : timeUntil(entry.item.expiresAt, now),
            state: expired ? 'failed' : 'current',
          },
        ]
      : [
          {
            label: 'Drift verdict recorded',
            meta: timeAgo(entry.item.createdAt, now),
            state: 'done',
          },
          { label: `Autopilot proposed ${entry.item.action.replace(/_/g, ' ')}`, state: 'done' },
          {
            label: expired ? 'Timed out' : 'Awaiting your decision',
            meta: expired ? undefined : timeUntil(entry.item.expiresAt, now),
            state: expired ? 'failed' : 'current',
          },
        ];

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold text-ink">Timeline</h3>
      <ol className="space-y-0">
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          return (
            <li key={step.label} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-full',
                    step.state === 'done' && 'bg-ok/15 text-ok-text',
                    step.state === 'current' && 'bg-warn/15 text-warn-text',
                    step.state === 'failed' && 'bg-panel-2 text-ink-3',
                  )}
                >
                  {step.state === 'done' ? (
                    <Check className="size-3" />
                  ) : step.state === 'current' ? (
                    <span className="size-1.5 rounded-full bg-warn" />
                  ) : (
                    <X className="size-3" />
                  )}
                </span>
                {!last && <span className="w-px flex-1 bg-line" />}
              </div>
              <div className={cn('min-w-0', last ? 'pb-0' : 'pb-4')}>
                <p className="text-xs font-medium text-ink-2">{step.label}</p>
                {step.meta && <p className="text-2xs tabular-nums text-ink-3">{step.meta}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
