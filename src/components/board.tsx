'use client';

import { useEffect, useState } from 'react';
import { CirclePause, CirclePlay, CircleStop, ListOrdered, RefreshCw, Search } from 'lucide-react';

import type { Task, TaskStatus } from '@/lib/types';
import { LABEL_COLORS } from '@/components/shared/label-chip';
import {
  countActiveSessions,
  type ExecutionConfig,
  getExecutionConfig,
  isNonAgentTask,
  pollNow,
  setExecutionConfig,
  stopAllTasks,
} from '@/components/shared/task-actions';
import { AddRepoModal } from '@/components/add-repo-modal';
import { orderQueue } from '@/lib/queue-order';
import { QueueModal } from '@/components/queue-modal';
import { useRepo } from '@/components/shared/use-repo';
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
  const { repos, current, loaded } = useRepo();
  const [addingRepo, setAddingRepo] = useState(false);
  const { tasks } = useTasks();
  const [query, setQuery] = useState('');
  const [polling, setPolling] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [config, setConfig] = useState<ExecutionConfig | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  // Empty selection = show everything.
  const [activeLabels, setActiveLabels] = useState<ReadonlySet<string>>(new Set());
  const activeSessions = countActiveSessions(tasks);

  // The auto-pickup queue: ready, agent-eligible tickets in execution order —
  // the same orderQueue() the loop drains with, so this list is what actually runs.
  const queueOrder = config?.queueOrder ?? 'oldest';
  const queue = orderQueue(
    tasks.filter((task) => task.status === 'ready' && !isNonAgentTask(task)),
    queueOrder,
    config?.manualQueue ?? []
  );

  /** Persist a hand-arranged queue (issue numbers, in order). */
  const saveQueueOrder = (issueNumbers: number[]) => {
    if (!current) return;
    setConfig((prev) => (prev ? { ...prev, manualQueue: issueNumbers } : prev)); // optimistic
    setExecutionConfig(current.id, { manualQueue: issueNumbers })
      .then(setConfig)
      .catch(() => {});
  };

  // Auto-pickup lives on this board; fetch the repo's config to reflect it.
  // Reset during render on repo change (derived-state pattern) so the effect only fetches.
  const [configRepoId, setConfigRepoId] = useState<string | null>(current?.id ?? null);
  if (configRepoId !== (current?.id ?? null)) {
    setConfigRepoId(current?.id ?? null);
    setConfig(null);
  }
  useEffect(() => {
    if (!current) return;
    const repoId = current.id;
    const load = () => getExecutionConfig(repoId).then(setConfig).catch(() => {});
    load();
    // Poll so the toggle reflects auto-pickup turning itself off at the per-run cap.
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [current]);

  const toggleAutoPickup = (on: boolean) => {
    if (!current) return;
    const repoId = current.id;
    setConfig((prev) => (prev ? { ...prev, autoStart: on } : prev)); // optimistic
    setExecutionConfig(repoId, { autoStart: on })
      .then((saved) => {
        setConfig(saved);
        if (on) return pollNow(repoId); // kick a cycle so pickup starts now
      })
      .catch(() => {});
  };

  const handlePollNow = () => {
    if (!current) return;
    setPolling(true);
    pollNow(current.id)
      .catch(() => {})
      .finally(() => setPolling(false));
  };

  const handleStopAll = () => {
    if (!current) return;
    const repoId = current.id;
    setStopping(true);
    // Also turn auto-pickup off, otherwise the loop would re-claim what we stop.
    setConfig((prev) => (prev ? { ...prev, autoStart: false } : prev));
    setExecutionConfig(repoId, { autoStart: false }).then(setConfig).catch(() => {});
    stopAllTasks(repoId, tasks)
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

  // No repos registered yet — offer the add flow instead of an empty board.
  if (loaded && repos.length === 0) {
    return (
      <div className="flex h-[calc(100dvh-57px)] items-center justify-center p-4">
        <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg bg-elevated-secondary p-8 text-center">
          <h2 className="text-sm font-bold">Add a repository</h2>
          <p className="text-xs leading-5 text-muted-foreground">
            Register a local git repo (with a GitHub remote) to manage its issues and agent
            sessions here.
          </p>
          <button
            type="button"
            onClick={() => setAddingRepo(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            + Add repo
          </button>
          {addingRepo && <AddRepoModal onClose={() => setAddingRepo(false)} />}
        </div>
      </div>
    );
  }

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
            title="Sync GitHub issues to the board now"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-elevated-secondary px-3 text-xs font-medium hover:bg-background-hover disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${polling ? 'animate-spin' : ''}`} />
            Pull issues
          </button>
          <button
            type="button"
            disabled={stopping || activeSessions === 0}
            onClick={handleStopAll}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive-solid px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <CircleStop className="h-3.5 w-3.5" />
            Stop all
          </button>
          {current?.htmlUrl && (
            <button
              type="button"
              onClick={() => setQueueOpen(true)}
              title="See the tickets auto-pickup will run, in order"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-elevated-secondary px-3 text-xs font-medium hover:bg-background-hover"
            >
              <ListOrdered className="h-3.5 w-3.5" />
              Queue{queue.length > 0 ? ` (${queue.length})` : ''}
            </button>
          )}
          {current?.htmlUrl &&
            (config?.autoStart ? (
              <button
                type="button"
                onClick={() => toggleAutoPickup(false)}
                title="Pause auto-pickup: no new tickets are started. In-progress agents keep running (use Stop all to abort them)."
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-elevated-secondary px-3 text-xs font-medium hover:bg-background-hover"
              >
                <CirclePause className="h-3.5 w-3.5" />
                Pause pickup
              </button>
            ) : (
              <button
                type="button"
                disabled={!config}
                onClick={() => toggleAutoPickup(true)}
                title="Start agents on ready tickets, up to the concurrency cap (oldest first). Configure in Settings → Execution."
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                <CirclePlay className="h-3.5 w-3.5" />
                Start agents
              </button>
            ))}
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
      {queueOpen && (
        <QueueModal
          queue={queue}
          queueOrder={queueOrder}
          tasksPerRun={config?.tasksPerRun ?? null}
          maxActive={config?.maxActive ?? 1}
          isManuallyOrdered={(config?.manualQueue ?? []).length > 0}
          onReorder={saveQueueOrder}
          onClose={() => setQueueOpen(false)}
        />
      )}
    </div>
  );
}
