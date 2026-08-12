import { CircleCheck, CircleSlash, Clock, Eye, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * How an action-log entry ended.
 *
 * Colour alone would put five outcomes on a three-step semantic scale, so each
 * carries an icon: `shadowed` and `skipped_cooldown` are both "nothing
 * happened", but for opposite reasons, and an operator reading an audit trail
 * needs to tell them apart at a glance.
 */
const OUTCOME: Record<string, { label: string; className: string; Icon: typeof CircleCheck }> = {
  executed: { label: 'Executed', className: 'text-ok-text', Icon: CircleCheck },
  shadowed: { label: 'Shadowed', className: 'text-ink-3', Icon: Eye },
  pending_approval: { label: 'Awaiting approval', className: 'text-warn-text', Icon: Clock },
  skipped_cooldown: { label: 'Skipped (cooldown)', className: 'text-ink-3', Icon: CircleSlash },
  failed: { label: 'Failed', className: 'text-danger-text', Icon: TriangleAlert },
};

export function OutcomeLabel({ outcome }: { outcome: string }) {
  const entry = OUTCOME[outcome];
  if (!entry) {
    return <span className="text-2xs text-ink-2">{outcome.replace(/_/g, ' ')}</span>;
  }

  const { label, className, Icon } = entry;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-2xs font-medium', className)}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}
