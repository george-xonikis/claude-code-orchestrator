'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Settings } from 'lucide-react';

import type { Task } from '@/lib/types';
import { formatModel } from '@/components/shared/format';
import { LabelChip } from '@/components/shared/label-chip';
import { StatusBadge } from '@/components/shared/status-badge';
import {
  isNonAgentTask,
  pushTask,
  retryTask,
  startTask,
  stopTask,
} from '@/components/shared/task-actions';
import { TaskSettingsModal } from '@/components/task-settings-modal';
import { useRepo } from '@/components/shared/use-repo';

/** Selected repo id for API calls and issue-detail links. */
function useRepoId(): string {
  return useRepo().current?.id ?? '';
}

/** Detail-page URL for an issue, scoped to the selected repo. */
function issueHref(repoId: string, issueNumber: number): string {
  return `/issues/${issueNumber}?repo=${encodeURIComponent(repoId)}`;
}

/** Re-render on an interval so elapsed-time chips stay current. */
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

/** Card wrapper — the whole card navigates to the issue detail page. */
function CardShell({
  task,
  className,
  children,
}: {
  task: Task;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const repoId = useRepoId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const href = issueHref(repoId, task.issueNumber);
  return (
    <>
      <div
        role="link"
        tabIndex={0}
        aria-label={`Issue #${task.issueNumber}: ${task.title}`}
        onClick={() => router.push(href)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') router.push(href);
        }}
        className={`group relative flex min-h-52 cursor-pointer flex-col rounded-lg bg-elevated-secondary p-4 ${className ?? ''}`}
      >
        <button
          type="button"
          aria-label={`Settings for issue #${task.issueNumber}`}
          onClick={stop(() => setSettingsOpen(true))}
          className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-50 hover:bg-background-hover hover:opacity-100"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        {children}
      </div>
      {settingsOpen && (
        <TaskSettingsModal repoId={repoId} task={task} onClose={() => setSettingsOpen(false)} />
      )}
    </>
  );
}

function stop(handler: () => void) {
  return (event: React.MouseEvent) => {
    event.stopPropagation();
    handler();
  };
}

/** Surface a failed card action instead of silently doing nothing. */
export function alertActionError(err: unknown): void {
  window.alert(err instanceof Error ? err.message : String(err));
}

/** GitHub labels (minus agent-* plumbing, which the column/badge already shows), then assignees on their own row. */
function MetaRow({ task }: { task: Task }) {
  const labels = (task.labels ?? []).filter((label) => !label.startsWith('agent-'));
  const assignees = task.assignees ?? [];
  if (labels.length === 0 && assignees.length === 0 && !task.model) return null;
  const meta = [
    ...assignees.map((login) => `@${login}`),
    task.model ? formatModel(task.model) : null,
  ].filter(Boolean);
  return (
    <>
      {labels.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {labels.map((label) => (
            <LabelChip key={label} label={label} />
          ))}
        </div>
      )}
      {meta.length > 0 && (
        <div className="mt-1.5 truncate text-[11px] text-muted-foreground">{meta.join(' · ')}</div>
      )}
    </>
  );
}

function ReadyCard({ task }: { task: Task }) {
  const repoId = useRepoId();
  const [busy, setBusy] = useState(false);
  return (
    <CardShell task={task}>
      <div className="text-xs font-medium text-muted-foreground">#{task.issueNumber}</div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{task.title}</div>
      <MetaRow task={task} />
      {isNonAgentTask(task) ? (
        <div className="mt-auto flex h-8 w-full shrink-0 items-center justify-center rounded-md border border-border text-xs font-medium text-muted-foreground">
          Non-agent task
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={stop(() => {
            setBusy(true);
            startTask(repoId, task.issueNumber).catch((err) => {
              alertActionError(err);
              setBusy(false);
            });
          })}
          className="mt-auto inline-flex h-8 w-full shrink-0 items-center justify-center rounded-md bg-primary px-2.5 text-xs font-medium whitespace-nowrap text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          ▶ Start agent
        </button>
      )}
    </CardShell>
  );
}

function WorkingCard({ task }: { task: Task }) {
  const now = useNow();
  const router = useRouter();
  const repoId = useRepoId();
  const lastLog = task.logTail?.[task.logTail.length - 1];
  return (
    <CardShell task={task} className="border border-info/40">
      <div className="flex items-center justify-between pr-8">
        <div className="text-xs font-medium text-muted-foreground">#{task.issueNumber}</div>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-info">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-info"></span>
          {formatElapsed(task.startedAt, now)}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{task.title}</div>
      <MetaRow task={task} />
      {task.branch && (
        <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{task.branch}</div>
      )}
      {lastLog && (
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{lastLog}</div>
      )}
      <div className="mt-auto flex gap-1.5 pt-3">
        <button
          type="button"
          onClick={stop(() => router.push(issueHref(repoId, task.issueNumber)))}
          className="inline-flex h-8 flex-1 items-center justify-center rounded-md border border-border bg-elevated-secondary px-2.5 text-xs font-medium whitespace-nowrap hover:bg-background-hover"
        >
          Logs
        </button>
        <button
          type="button"
          aria-label={`Stop agent on issue #${task.issueNumber}`}
          onClick={stop(() => {
            stopTask(repoId, task.issueNumber).catch(alertActionError);
          })}
          className="inline-flex h-8 items-center justify-center rounded-md bg-destructive-solid px-2.5 text-xs font-medium whitespace-nowrap text-white hover:opacity-90"
        >
          ■
        </button>
      </div>
    </CardShell>
  );
}

function NeedsInputCard({ task }: { task: Task }) {
  const router = useRouter();
  const repoId = useRepoId();
  return (
    <CardShell task={task} className="border border-warning/40">
      <div className="flex items-center justify-between pr-8">
        <div className="text-xs font-medium text-muted-foreground">#{task.issueNumber}</div>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-warning">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning"></span>
          needs input
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{task.title}</div>
      <MetaRow task={task} />
      {task.branch && (
        <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{task.branch}</div>
      )}
      {task.question && (
        <p className="mt-2 line-clamp-1 text-[11px] leading-snug text-muted-foreground">
          ❓ {task.question}
        </p>
      )}
      <button
        type="button"
        onClick={stop(() => router.push(issueHref(repoId, task.issueNumber)))}
        className="mt-auto inline-flex h-8 w-full shrink-0 items-center justify-center rounded-md bg-primary px-2.5 text-xs font-medium whitespace-nowrap text-primary-foreground hover:opacity-90"
      >
        Answer
      </button>
    </CardShell>
  );
}

function PrOpenCard({ task }: { task: Task }) {
  return (
    <CardShell task={task}>
      <div className="flex items-center justify-between pr-8">
        <div className="text-xs font-medium text-muted-foreground">#{task.issueNumber}</div>
        <StatusBadge status="pr_open" />
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{task.title}</div>
      <MetaRow task={task} />
      {(task.prNumber ?? task.branch) && (
        <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
          {task.prNumber ? `PR #${task.prNumber}` : task.branch}
        </div>
      )}
      <a
        href={task.prUrl ?? '#'}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        className="mt-auto inline-flex h-8 w-full shrink-0 items-center justify-center rounded-md border border-border bg-elevated-secondary px-2.5 text-xs font-medium whitespace-nowrap hover:bg-background-hover"
      >
        Review PR ↗
      </a>
    </CardShell>
  );
}

function CommittedCard({ task }: { task: Task }) {
  const router = useRouter();
  const repoId = useRepoId();
  const [busy, setBusy] = useState(false);
  return (
    <CardShell task={task} className="border border-primary/40">
      <div className="flex items-center justify-between pr-8">
        <div className="text-xs font-medium text-muted-foreground">#{task.issueNumber}</div>
        <StatusBadge status="committed" />
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{task.title}</div>
      <MetaRow task={task} />
      {task.branch && (
        <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{task.branch}</div>
      )}
      <div className="mt-auto flex gap-1.5 pt-3">
        <button
          type="button"
          disabled={busy}
          onClick={stop(() => {
            setBusy(true);
            pushTask(repoId, task.issueNumber).catch((err) => {
              alertActionError(err);
              setBusy(false);
            });
          })}
          className="inline-flex h-8 flex-1 items-center justify-center rounded-md bg-primary px-2.5 text-xs font-medium whitespace-nowrap text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          ⇧ Push &amp; open PR
        </button>
        <button
          type="button"
          onClick={stop(() => router.push(issueHref(repoId, task.issueNumber)))}
          className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-elevated-secondary px-2.5 text-xs font-medium whitespace-nowrap hover:bg-background-hover"
        >
          Logs
        </button>
      </div>
    </CardShell>
  );
}

function FailedCard({ task }: { task: Task }) {
  const router = useRouter();
  const repoId = useRepoId();
  const [busy, setBusy] = useState(false);
  return (
    <CardShell task={task} className="border border-destructive/40">
      <div className="text-xs font-medium text-muted-foreground">#{task.issueNumber}</div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{task.title}</div>
      <MetaRow task={task} />
      {task.branch && (
        <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{task.branch}</div>
      )}
      <div className="mt-2 line-clamp-2 text-[11px] leading-snug text-destructive">
        {task.error ?? 'Agent session failed'}
      </div>
      <div className="mt-auto flex gap-1.5 pt-3">
        <button
          type="button"
          disabled={busy}
          onClick={stop(() => {
            setBusy(true);
            retryTask(repoId, task.issueNumber).catch((err) => {
              alertActionError(err);
              setBusy(false);
            });
          })}
          className="inline-flex h-8 flex-1 items-center justify-center rounded-md bg-primary px-2.5 text-xs font-medium whitespace-nowrap text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={stop(() => router.push(issueHref(repoId, task.issueNumber)))}
          className="inline-flex h-8 flex-1 items-center justify-center rounded-md border border-border bg-elevated-secondary px-2.5 text-xs font-medium whitespace-nowrap hover:bg-background-hover"
        >
          Logs
        </button>
      </div>
    </CardShell>
  );
}

export function TaskCard({ task }: { task: Task }) {
  switch (task.status) {
    case 'ready':
      return <ReadyCard task={task} />;
    case 'working':
      return <WorkingCard task={task} />;
    case 'needs_input':
      return <NeedsInputCard task={task} />;
    case 'committed':
      return <CommittedCard task={task} />;
    case 'pr_open':
      return <PrOpenCard task={task} />;
    case 'failed':
      return <FailedCard task={task} />;
  }
}
