'use client';

import { useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';

import type { Task, TaskStatus } from '@/lib/types';
import { LABEL_COLORS } from '@/components/shared/label-chip';
import { countActiveSessions, pollNow, stopAllTasks } from '@/components/shared/task-actions';
import { useTasks } from '@/components/shared/use-tasks';
import { TaskCard } from '@/components/task-card';

/** The only labels offered as board filters. */
const FILTER_LABELS = ['Bug', 'FE', 'BE', 'AI', 'Infra'] as const;

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'ready', label: 'Ready' },
  { status: 'working', label: 'Agent working' },
  { status: 'needs_input', label: 'Needs input' },
  { status: 'committed', label: 'Committed' },
  { status: 'pr_open', label: 'PR open' },
  { status: 'failed', label: 'Failed' },
];

function matchesQuery(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // "#312", "312", any title substring, or an assignee ("george" / "@george").
  return (
    String(task.issueNumber).includes(q.replace(/^#/, '')) ||
    task.title.toLowerCase().includes(q) ||
    (task.assignees ?? []).some((login) => login.toLowerCase().includes(q.replace(/^@/, '')))
  );
}

function displayLabels(task: Task): string[] {
  return (task.labels ?? []).filter((label) => !label.startsWith('agent-'));
}

export function Board() {
  const { tasks } = useTasks();
  const [query, setQuery] = useState('');
  const [polling, setPolling] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Empty selection = show everything.
  const [activeLabels, setActiveLabels] = useState<ReadonlySet<string>>(new Set());
  const activeSessions = countActiveSessions(tasks);

  const handlePollNow = () => {
    setPolling(true);
    pollNow()
      .catch(() => {})
      .finally(() => setPolling(false));
  };

  const handleStopAll = () => {
    setStopping(true);
    stopAllTasks(tasks)
      .catch(() => {})
      .finally(() => setStopping(false));
  };

  const toggleLabel = (label: string) => {
    setActiveLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  // Newest issues (highest number) first in every column.
  const visible = tasks
    .filter((task) => matchesQuery(task, query))
    .filter(
      (task) =>
        activeLabels.size === 0 ||
        displayLabels(task).some((label) => activeLabels.has(label))
    )
    .sort((a, b) => b.issueNumber - a.issueNumber);
  return (
    <div className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm flex-1 basis-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by number, title, or assignee…"
            aria-label="Search issues"
            className="h-8 w-full rounded-md border border-border bg-elevated-secondary pl-8 pr-3 text-sm placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
          />
        </div>
        <div role="group" aria-label="Filter by label" className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={activeLabels.size === 0}
            onClick={() => setActiveLabels(new Set())}
            className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium ${
              activeLabels.size === 0
                ? 'border-transparent bg-primary text-primary-foreground'
                : 'border-border bg-elevated-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            All
          </button>
          {FILTER_LABELS.map((label) => {
            const active = activeLabels.has(label);
            const color = LABEL_COLORS[label];
            return (
              <button
                key={label}
                type="button"
                aria-pressed={active}
                onClick={() => toggleLabel(label)}
                style={{ backgroundColor: color.bg, color: color.text }}
                className={`inline-flex h-7 items-center rounded-full px-2.5 text-xs font-semibold transition-opacity ${
                  active ? 'opacity-100 ring-2 ring-ring' : 'opacity-50 hover:opacity-100'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={polling}
            onClick={handlePollNow}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-elevated-secondary px-3 text-xs font-medium hover:bg-background-hover disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${polling ? 'animate-spin' : ''}`} />
            Poll now
          </button>
          <button
            type="button"
            disabled={stopping || activeSessions === 0}
            onClick={handleStopAll}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive-solid px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            ■ Stop all
          </button>
        </div>
      </div>
      <div className="grid grid-cols-6 gap-3">
        {COLUMNS.map(({ status, label }) => {
          const columnTasks = visible.filter((task) => task.status === status);
        return (
            <div key={status}>
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {label}
                </span>
                <span className="text-xs text-muted-foreground">{columnTasks.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {columnTasks.map((task) => (
                  <TaskCard key={task.issueNumber} task={task} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
