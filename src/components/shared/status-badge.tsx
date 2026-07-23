import type { TaskStatus } from '@/lib/types';

export const STATUS_BADGES: Record<TaskStatus, { label: string; className: string }> = {
  ready: { label: 'ready', className: 'bg-secondary text-secondary-foreground' },
  working: { label: 'working', className: 'bg-info-muted text-info' },
  needs_input: { label: 'needs input', className: 'bg-warning-muted text-warning' },
  committed: { label: 'committed', className: 'bg-primary/10 text-primary' },
  pr_open: { label: 'PR open', className: 'bg-success-muted text-success' },
  failed: { label: 'failed', className: 'bg-destructive-muted text-destructive' },
};

/** Rounded status pill in the mockup's badge style (bg-{tone}-muted / text-{tone}). */
export function StatusBadge({ status }: { status: TaskStatus }) {
  const { label, className } = STATUS_BADGES[status];
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}
