import { useEffect, useState } from 'react';
import { useParams, useRevalidator, useRouteLoaderData } from 'react-router';
import { CheckCircle2, ShieldAlert, Timer } from 'lucide-react';
import { client, type Approval, type ToolCallApproval } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, SeverityBadge, timeAgo, timeUntil } from '@/components/domain';

/** Re-renders on a 1s tick so the countdowns below actually count down. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function DecisionButtons({
  onDecide,
  busy,
}: {
  onDecide: (decision: 'approved' | 'rejected') => void;
  busy: boolean;
}) {
  return (
    <div className="flex shrink-0 gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide('rejected')}>
        Reject
      </Button>
      <Button size="sm" disabled={busy} onClick={() => onDecide('approved')}>
        Approve
      </Button>
    </div>
  );
}

export function AgentApprovalsPage() {
  const { agentId } = useParams();
  const { pendingApprovals, pendingToolCalls } = useRouteLoaderData(
    'agent-approvals',
  ) as ApprovalsLoaderData;
  const revalidator = useRevalidator();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  async function decide(
    kind: 'approval' | 'toolCall',
    id: string,
    decision: 'approved' | 'rejected',
  ) {
    setBusyId(id);
    setError(null);
    try {
      if (kind === 'approval') await client.resolveApproval(agentId!, id, decision);
      else await client.resolveToolCall(agentId!, id, decision);
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to resolve');
    } finally {
      setBusyId(null);
    }
  }

  const nothingPending = pendingApprovals.length === 0 && pendingToolCalls.length === 0;

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md bg-danger/12 px-3 py-2 text-sm text-danger-text" role="alert">
          {error}
        </p>
      )}

      {nothingPending && (
        <Card>
          <EmptyState icon={<CheckCircle2 className="size-6" />} title="Nothing awaiting a decision">
            Control actions proposed by Autopilot, and tool calls gated by this agent's policies,
            both land here. A gated tool call holds its agent's request open until you decide, so
            this queue is worth watching.
          </EmptyState>
        </Card>
      )}

      {/* Tool calls first: each one is holding a live request open. */}
      {pendingToolCalls.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Timer className="size-4 text-warn-text" />
              Tool calls awaiting approval
              <span className="text-xs font-normal text-ink-3">
                blocking a live request
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingToolCalls.map((toolCall: ToolCallApproval) => {
              const expired = toolCall.expiresAt <= now;
              return (
                <div
                  key={toolCall.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-panel-2/50 p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-mono text-sm font-medium text-ink">{toolCall.tool}</p>
                    {toolCall.matchedReason && (
                      <p className="text-xs text-ink-2">{toolCall.matchedReason}</p>
                    )}
                    {toolCall.fieldPath && (
                      <p className="text-2xs text-ink-3">
                        matched on <code className="font-mono">{toolCall.fieldPath}</code>
                      </p>
                    )}
                    {toolCall.inputSummary && (
                      <pre className="mt-1 max-w-full overflow-x-auto rounded bg-canvas px-2 py-1 font-mono text-2xs text-ink-2">
                        {JSON.stringify(toolCall.inputSummary)}
                      </pre>
                    )}
                    <p
                      className={
                        expired
                          ? 'text-2xs font-medium text-danger-text'
                          : 'text-2xs tabular-nums text-warn-text'
                      }
                    >
                      {expired ? 'timed out — the agent already got its answer' : timeUntil(toolCall.expiresAt, now)}
                    </p>
                  </div>
                  {!expired && (
                    <DecisionButtons
                      busy={busyId === toolCall.id}
                      onDecide={(decision) => decide('toolCall', toolCall.id, decision)}
                    />
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {pendingApprovals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-ink-3" />
              Control actions awaiting approval
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingApprovals.map((approval: Approval) => (
              <div
                key={approval.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-panel-2/50 p-3"
              >
                <div className="min-w-0 space-y-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-ink">
                    <code className="font-mono">{approval.action}</code>
                    <SeverityBadge severity={approval.severity} />
                  </p>
                  {approval.reasons.length > 0 && (
                    <ul className="list-inside list-disc text-xs text-ink-2">
                      {approval.reasons.map((reason, index) => (
                        <li key={index}>{reason}</li>
                      ))}
                    </ul>
                  )}
                  <p className="text-2xs text-ink-3">requested {timeAgo(approval.createdAt, now)}</p>
                </div>
                <DecisionButtons
                  busy={busyId === approval.id}
                  onDecide={(decision) => decide('approval', approval.id, decision)}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export interface ApprovalsLoaderData {
  pendingApprovals: Approval[];
  pendingToolCalls: ToolCallApproval[];
}

export async function approvalsLoader({
  params,
}: {
  params: { agentId?: string };
}): Promise<ApprovalsLoaderData> {
  const agentId = params.agentId!;
  const [approvals, toolCalls] = await Promise.all([
    client.getApprovals(agentId),
    client.getPendingToolCalls(agentId),
  ]);
  return { pendingApprovals: approvals.approvals, pendingToolCalls: toolCalls.toolCalls };
}
