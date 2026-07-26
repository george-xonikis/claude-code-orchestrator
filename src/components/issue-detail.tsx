'use client';

import { useEffect, useRef, useState } from 'react';
import { formatModel } from '@/components/shared/format';
import { useRouter } from 'next/navigation';

import type { LogEvent, Task, TaskStatus } from '@/lib/types';
import { STATUS_BADGES } from '@/components/shared/status-badge';
import {
  ACTIVE_STATUSES,
  MANUAL_STATUSES,
  type ManualStatus,
  pushTask,
  replyTask,
  retryTask,
  setTaskStatus,
  stopTask,
} from '@/components/shared/task-actions';
import { useRepo } from '@/components/shared/use-repo';
import { useTasks } from '@/components/shared/use-tasks';

/** Selected repo id for API calls and issue-detail links. */
function useRepoId(): string {
  return useRepo().current?.id ?? '';
}

/** Detail-page URL for an issue, scoped to the selected repo. */
function issueHref(repoId: string, issueNumber: number): string {
  return `/issues/${issueNumber}?repo=${encodeURIComponent(repoId)}`;
}

/** Mockup left-list status dots (working/needs_input pulse, ready is faded). */
const STATUS_DOTS: Record<TaskStatus, string> = {
  ready: 'bg-muted-foreground/50',
  working: 'animate-pulse bg-info',
  needs_input: 'animate-pulse bg-warning',
  committed: 'bg-primary',
  pr_open: 'bg-success',
  failed: 'bg-destructive',
};

/** Mockup list order: blocked/running agents first, then results, then queue. */
const STATUS_ORDER: Record<TaskStatus, number> = {
  needs_input: 0,
  working: 1,
  committed: 2,
  pr_open: 3,
  failed: 4,
  ready: 5,
};

/** Colorize log lines by kind: prompt blue, success green, error red, question amber. */
const LOG_KIND_CLASS: Partial<Record<LogEvent['kind'], string>> = {
  prompt: 'text-primary font-medium',
  result: 'text-success',
  error: 'text-destructive',
  question: 'text-warning',
};

/** Re-render on an interval so elapsed-time labels stay current. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatElapsed(from: string | undefined, now: number): string {
  if (!from) return '0m';
  const mins = Math.max(0, Math.floor((now - Date.parse(from)) / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** `/Users/…/<repo>/.worktrees/issue-312` → `.worktrees/issue-312` (mockup meta style). */
function shortWorktreePath(path: string): string {
  const index = path.indexOf('.worktrees');
  return index >= 0 ? path.slice(index) : path;
}

function formatTs(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-GB', { hour12: false });
}

function substatus(task: Task, now: number): { text: string; className: string } {
  const muted = 'mt-0.5 block truncate text-xs text-muted-foreground';
  switch (task.status) {
    case 'needs_input':
      return {
        text: `needs input · waiting ${formatElapsed(task.updatedAt ?? task.startedAt, now)}`,
        className: 'mt-0.5 block text-xs font-medium text-warning',
      };
    case 'working':
      return { text: `working · ${formatElapsed(task.startedAt, now)}`, className: muted };
    case 'committed':
      return { text: 'committed · awaiting push', className: muted };
    case 'pr_open':
      return { text: task.prNumber ? `PR #${task.prNumber}` : 'PR open', className: muted };
    case 'failed':
      return { text: task.error ? `failed · ${task.error}` : 'failed', className: muted };
    case 'ready':
      return { text: 'ready', className: muted };
  }
}

function TaskListItem({ task, selected }: { task: Task; selected: boolean }) {
  const router = useRouter();
  const repoId = useRepoId();
  const now = useNow();
  const sub = substatus(task, now);
  return (
    <button
      type="button"
      onClick={() => router.push(issueHref(repoId, task.issueNumber))}
      className={
        selected
          ? 'flex items-start gap-2.5 border-l-2 border-primary bg-background-hover px-4 py-3 text-left'
          : 'flex items-start gap-2.5 border-l-2 border-transparent px-4 py-3 text-left hover:bg-background-hover'
      }
    >
      <span
        className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOTS[task.status]}`}
      ></span>
      <span className="min-w-0">
        <span
          className={`block text-sm leading-snug ${selected ? 'font-semibold' : 'font-medium'}`}
        >
          #{task.issueNumber} {task.title}
        </span>
        <span className={sub.className}>{sub.text}</span>
      </span>
    </button>
  );
}

/** The task instructions the agent was launched with — collapsed to one row by default. */
function PromptPanel({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border px-5 py-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-primary">
          Task prompt
        </span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {prompt.split('\n', 1)[0]}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {open ? '▲ collapse' : '▼ expand'}
        </span>
      </button>
      {open && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-elevated-secondary p-3 font-mono text-[11px] leading-5 text-foreground">
          {prompt}
        </pre>
      )}
    </div>
  );
}

function QuestionBanner({ task }: { task: Task }) {
  const repoId = useRepoId();
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = () => {
    const message = reply.trim();
    if (!message) return;
    setSending(true);
    replyTask(repoId, task.issueNumber, message)
      .then(() => setReply(''))
      .catch(() => {})
      .finally(() => setSending(false));
  };

  return (
    <div className="border-b border-border bg-warning-muted px-5 py-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-warning">❓</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-warning">
            Agent question
          </div>
          <p className="mt-1 text-sm leading-snug">{task.question}</p>
          <textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            placeholder="Reply to resume the session…"
            className="mt-3 flex min-h-16 w-full rounded-md border border-border bg-elevated-secondary px-3 py-2 text-sm placeholder:text-muted-foreground"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Replying resumes the session with its full context. The session stays alive while
              waiting.
            </span>
            <button
              type="button"
              disabled={sending || !reply.trim()}
              onClick={handleSend}
              className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              Send reply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LogTail({ issueNumber, fallbackLines }: { issueNumber: number; fallbackLines?: string[] }) {
  const repoId = useRepoId();
  const [lines, setLines] = useState<LogEvent[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset the buffer during render when the issue or repo changes (React's
  // derived-state pattern), so the effect below only manages the EventSource
  // subscription. Issue numbers are NOT unique across repos.
  const streamKey = `${repoId}:${issueNumber}`;
  const [streamedKey, setStreamedKey] = useState(streamKey);
  if (streamedKey !== streamKey) {
    setStreamedKey(streamKey);
    setLines([]);
  }

  useEffect(() => {
    if (!repoId) return;
    const source = new EventSource(
      `/api/tasks/${issueNumber}/logs?repo=${encodeURIComponent(repoId)}`,
    );
    source.onmessage = (event) => {
      let entry: LogEvent;
      try {
        const parsed = JSON.parse(event.data) as Partial<LogEvent>;
        entry = {
          ts: parsed.ts ?? new Date().toISOString(),
          kind: parsed.kind ?? 'info',
          text: parsed.text ?? String(event.data),
        };
      } catch {
        entry = { ts: new Date().toISOString(), kind: 'info', text: String(event.data) };
      }
      setLines((prev) => [...prev.slice(-499), entry]);
    };
    // EventSource reconnects automatically — nothing to do on error.
    return () => source.close();
  }, [repoId, issueNumber]);

  // Follow the newest line ONLY while the user is already at the bottom.
  // Scrolling up to read pins the view in place; scrolling back down (within
  // the threshold) resumes following.
  const followRef = useRef(true);
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = containerRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto overflow-x-hidden bg-elevated-secondary p-4 font-mono text-[11px] leading-5 text-muted-foreground"
    >
      {lines.length === 0 &&
        fallbackLines?.map((text, index) => (
          <div key={index} className="mb-0.5 whitespace-pre-wrap break-all">
            {text}
          </div>
        ))}
      {lines.map((line, index) => (
        <div
          key={index}
          className={`mb-0.5 whitespace-pre-wrap break-all ${LOG_KIND_CLASS[line.kind] ?? ''}`}
        >
          {formatTs(line.ts)}  {line.text}
        </div>
      ))}
    </div>
  );
}

function DetailPane({ task }: { task: Task }) {
  const { current } = useRepo();
  const repoId = current?.id ?? '';
  const now = useNow();
  const [stopping, setStopping] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const badge = STATUS_BADGES[task.status];
  const badgeLabel =
    task.status === 'needs_input'
      ? `needs input · waiting ${formatElapsed(task.updatedAt ?? task.startedAt, now)}`
      : badge.label;
  const holdsSlot = ACTIVE_STATUSES.includes(task.status);

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold">
                #{task.issueNumber} {task.title}
              </span>
              <span
                className={`inline-flex items-center justify-center rounded-full border border-transparent px-2.5 py-1 text-xs font-medium ${badge.className}`}
              >
                {badgeLabel}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
              {task.worktreePath && <span>wt: {shortWorktreePath(task.worktreePath)}</span>}
              {task.branch && <span>branch: {task.branch}</span>}
              {task.model && <span>model: {formatModel(task.model)}</span>}
              {task.turns !== undefined && <span>turns: {task.turns}</span>}
              {task.costUsd !== undefined && <span>${task.costUsd.toFixed(2)}</span>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {!holdsSlot && (
            <select
              value={task.status}
              aria-label="Set task status"
              onChange={(event) => {
                setTaskStatus(repoId, task.issueNumber, event.target.value as ManualStatus).catch(
                  () => {},
                );
              }}
              className="h-8 rounded-md border border-border bg-elevated-secondary px-2 text-xs font-medium outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
            >
              {!MANUAL_STATUSES.includes(task.status as ManualStatus) && (
                <option value={task.status} disabled>
                  {STATUS_BADGES[task.status].label}
                </option>
              )}
              {MANUAL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_BADGES[status].label}
                </option>
              ))}
            </select>
          )}
          {current?.htmlUrl && (
            <a
              href={`${current.htmlUrl}/issues/${task.issueNumber}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-elevated-secondary px-3 text-sm font-medium hover:bg-background-hover"
            >
              Open issue ↗
            </a>
          )}
          {task.status === 'failed' && (
            <button
              type="button"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                retryTask(repoId, task.issueNumber)
                  .catch((err) => window.alert(err instanceof Error ? err.message : String(err)))
                  .finally(() => setRetrying(false));
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              ↻ Retry
            </button>
          )}
          {task.status === 'committed' && (
            <button
              type="button"
              disabled={pushing}
              onClick={() => {
                setPushing(true);
                pushTask(repoId, task.issueNumber)
                  .catch(() => {})
                  .finally(() => setPushing(false));
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              ⇧ Push &amp; open PR
            </button>
          )}
          {holdsSlot && (
            <button
              type="button"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                stopTask(repoId, task.issueNumber)
                  .catch(() => {})
                  .finally(() => setStopping(false));
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive-solid px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              ■ Stop
            </button>
          )}
        </div>
      </div>
      {task.prompt && <PromptPanel prompt={task.prompt} />}
      {task.status === 'needs_input' && <QuestionBanner task={task} />}
      <LogTail issueNumber={task.issueNumber} fallbackLines={task.logTail} />
    </div>
  );
}

export function IssueDetail({ issueNumber }: { issueNumber: number }) {
  const { tasks } = useTasks();
  // Within each status group, newest issues (highest number) first.
  const sorted = [...tasks].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.issueNumber - a.issueNumber,
  );
  const task = tasks.find((candidate) => candidate.issueNumber === issueNumber);

  return (
    <div className="grid h-[calc(100dvh-57px)] grid-cols-[280px_minmax(0,1fr)]">
      {/* Left: issue list */}
      <div className="overflow-y-auto border-r border-border">
        <div className="flex flex-col">
          {sorted.map((candidate) => (
            <TaskListItem
              key={candidate.issueNumber}
              task={candidate}
              selected={candidate.issueNumber === issueNumber}
            />
          ))}
        </div>
      </div>
      {/* Right: agent detail */}
      {task ? (
        <DetailPane key={task.issueNumber} task={task} />
      ) : (
        <div className="flex min-h-0 flex-col">
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <span className="text-sm font-bold">#{issueNumber}</span>
          </div>
          <div className="flex flex-1 items-center justify-center bg-elevated-secondary p-4 text-sm text-muted-foreground">
            Issue #{issueNumber} is not tracked by the orchestrator.
          </div>
        </div>
      )}
    </div>
  );
}
