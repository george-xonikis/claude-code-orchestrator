'use client';

import { useEffect, useState } from 'react';
import { GripVertical, X } from 'lucide-react';

import type { Task } from '@/lib/types';
import { LabelChip } from '@/components/shared/label-chip';

/**
 * The auto-pickup queue: the ready tickets that "Start agents" will run, in the
 * order the loop drains them. Drag a row to arrange the order by hand — it is
 * persisted (execution config `manualQueue`) and the loop honours it. When a
 * per-run cap is set, tickets past it wait for a later run.
 */
export function QueueModal({
  queue,
  queueOrder,
  tasksPerRun,
  maxActive,
  isManuallyOrdered,
  onReorder,
  onClose,
}: {
  queue: Task[];
  queueOrder: 'oldest' | 'newest';
  tasksPerRun: number | null;
  maxActive: number;
  isManuallyOrdered: boolean;
  onReorder: (issueNumbers: number[]) => void;
  onClose: () => void;
}) {
  // Index being dragged, and the row it is hovering over (the drop target).
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Move the dragged row to `to` and persist the whole queue's new order. */
  const commitDrop = (to: number) => {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === to) return;
    const next = [...queue];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next.map((task) => task.issueNumber));
  };

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
              {isManuallyOrdered
                ? 'Custom order'
                : queueOrder === 'newest'
                  ? 'Newest first'
                  : 'Oldest first'}{' '}
              · {tasksPerRun === null ? 'all' : tasksPerRun} per run · {maxActive} at a time ·
              drag to reorder
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {isManuallyOrdered && (
              <button
                type="button"
                onClick={() => onReorder([])}
                className="inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-background-hover hover:text-foreground"
              >
                Reset order
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-background-hover"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
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
                  <li
                    key={task.issueNumber}
                    draggable
                    onDragStart={(e) => {
                      setDragIndex(index);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      e.preventDefault(); // required to allow a drop
                      e.dataTransfer.dropEffect = 'move';
                      if (overIndex !== index) setOverIndex(index);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      commitDrop(index);
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                    className={dragIndex === index ? 'opacity-40' : ''}
                  >
                    {capBoundary && (
                      <div className="my-1.5 flex items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <span className="h-px flex-1 bg-border" />
                        picked up in a later run
                        <span className="h-px flex-1 bg-border" />
                      </div>
                    )}
                    <div
                      className={`flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 active:cursor-grabbing hover:bg-background-hover ${
                        overIndex === index && dragIndex !== null && dragIndex !== index
                          ? 'ring-1 ring-primary'
                          : ''
                      }`}
                    >
                      <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
