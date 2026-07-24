'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

import type { Task } from '@/lib/types';
import { LabelChip } from '@/components/shared/label-chip';

/**
 * The auto-pickup queue: the ready tickets that "Start agents" will run, in the
 * order the loop drains them (per the configured queue order). When a per-run
 * cap is set, tickets past it wait for a later run.
 */
export function QueueModal({
  queue,
  queueOrder,
  tasksPerRun,
  maxActive,
  onClose,
}: {
  queue: Task[];
  queueOrder: 'oldest' | 'newest';
  tasksPerRun: number | null;
  maxActive: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const displayLabels = (task: Task) =>
    (task.labels ?? []).filter((label) => !label.startsWith('agent-'));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="my-auto flex max-h-[92vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-main-surface-primary shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold">Task queue</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {queueOrder === 'newest' ? 'Newest first' : 'Oldest first'} ·{' '}
              {tasksPerRun === null ? 'all' : tasksPerRun} per run · {maxActive} at a time
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-background-hover"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto p-3">
          {queue.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No ready tickets to pick up. New issues appear here once they’re synced and not
              labeled <code className="font-mono text-[11px]">non-agent</code>.
            </p>
          ) : (
            <ol className="flex flex-col gap-1">
              {queue.map((task, index) => {
                const capBoundary =
                  tasksPerRun !== null && index === tasksPerRun && queue.length > tasksPerRun;
                return (
                  <li key={task.issueNumber}>
                    {capBoundary && (
                      <div className="my-1.5 flex items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <span className="h-px flex-1 bg-border" />
                        picked up in a later run
                        <span className="h-px flex-1 bg-border" />
                      </div>
                    )}
                    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-background-hover">
                      <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-muted-foreground">
                        #{task.issueNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                      <div className="flex shrink-0 flex-wrap items-center gap-1">
                        {displayLabels(task).map((label) => (
                          <LabelChip key={label} label={label} />
                        ))}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
