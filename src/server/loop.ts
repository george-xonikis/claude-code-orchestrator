import type { Task } from '@/lib/types';
import * as github from './github';
import * as sessions from './sessions';
import * as state from './state';
import * as worktrees from './worktrees';

/**
 * Orchestration loop: polls GitHub for all open issues every 2 minutes so the
 * board stays current, and mirrors task status as agent-* labels
 * (agent-working -> agent-committed -> agent-pr / agent-failed, plus
 * agent-needs-input while a session is paused on a question).
 * Sessions start ONLY from the dashboard's Start button — never automatically.
 *
 * The interval + wiring are lazily initialized behind a globalThis guard so
 * Next dev hot-reload doesn't duplicate the loop.
 */

const POLL_INTERVAL_MS = 2 * 60_000;

interface LoopGlobal {
  started: boolean;
  polling: boolean;
  /** Issues with a live session (working OR needs_input) — the slot count. */
  active: Set<number>;
  interval: ReturnType<typeof setInterval> | null;
}

const globalRef = globalThis as typeof globalThis & {
  __orchestratorLoop?: LoopGlobal;
};

function loop(): LoopGlobal {
  if (!globalRef.__orchestratorLoop) {
    globalRef.__orchestratorLoop = {
      started: false,
      polling: false,
      active: new Set(),
      interval: null,
    };
  }
  return globalRef.__orchestratorLoop;
}

function logError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[orchestrator] ${context}: ${message}`);
}

async function findTask(issueNumber: number): Promise<Task | undefined> {
  return (await state.getTasks()).find((t) => t.issueNumber === issueNumber);
}

// ---------------------------------------------------------------------------
// Session events -> state + labels + worktree lifecycle
// ---------------------------------------------------------------------------

/** GitHub/worktree side effects when a task's status actually changes. */
async function onStatusChange(issueNumber: number, task: Task): Promise<void> {
  const g = loop();
  switch (task.status) {
    case 'committed':
      // Session over, slot freed; the worktree stays until the developer pushes.
      g.active.delete(issueNumber);
      await github.setLabels(issueNumber, ['agent-committed']);
      break;
    case 'pr_open':
      g.active.delete(issueNumber);
      await github.setLabels(issueNumber, ['agent-pr']);
      await worktrees.removeWorktree(issueNumber);
      break;
    case 'failed':
      g.active.delete(issueNumber);
      await github.setLabels(issueNumber, ['agent-failed']);
      // Short reason only — never log dumps. Worktree is kept for retry.
      await github.commentOnIssue(
        issueNumber,
        `Agent session failed: ${task.error ?? 'unknown error'}`
      );
      break;
    case 'needs_input':
      await github.setLabels(issueNumber, ['agent-needs-input']);
      break;
    case 'working':
      // Resume after needs_input (initial claim sets the label itself).
      await github.setLabels(issueNumber, ['agent-working']);
      break;
    default:
      break;
  }
}

function handleSessionEvent(event: sessions.SessionEvent): void {
  void (async () => {
    if (event.log) {
      await state.appendLog(event.issueNumber, event.log);
    }
    if (event.patch) {
      const prev = await findTask(event.issueNumber);
      const merged = await state.upsertTask({
        issueNumber: event.issueNumber,
        ...event.patch,
      });
      if (prev?.status !== merged.status) {
        await onStatusChange(event.issueNumber, merged);
      }
    }
  })().catch((err) => logError(`session event for #${event.issueNumber}`, err));
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** Claim an issue: label agent-working, create/reuse worktree, start the session. */
async function claim(issueNumber: number, title: string): Promise<void> {
  const g = loop();
  g.active.add(issueNumber); // Reserve the slot up front.
  try {
    await github.setLabels(issueNumber, ['agent-working']);
    const wt = await worktrees.createWorktree(issueNumber);
    await state.upsertTask({
      issueNumber,
      title,
      status: 'working',
      worktreePath: wt.path,
      branch: wt.branch,
      error: undefined,
      question: undefined,
      prNumber: undefined,
      prUrl: undefined,
    });
    await sessions.startSession(issueNumber, wt.path, wt.branch);
  } catch (err) {
    g.active.delete(issueNumber);
    const message = err instanceof Error ? err.message : String(err);
    await state
      .upsertTask({ issueNumber, status: 'failed', error: message })
      .catch(() => {});
    await github.setLabels(issueNumber, ['agent-failed']).catch(() => {});
    await github
      .commentOnIssue(issueNumber, `Agent orchestrator could not start a session: ${message}`)
      .catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

async function poll(): Promise<void> {
  const g = loop();
  if (g.polling) return; // A cycle is already running.
  g.polling = true;
  try {
    // 1. Discover all open issues -> upsert as status ready.
    const issues = await github.listOpenIssues();
    const tasksByNumber = new Map(
      (await state.getTasks()).map((t) => [t.issueNumber, t])
    );
    const sameList = (a: string[] | undefined, b: string[]) =>
      JSON.stringify(a ?? []) === JSON.stringify(b);
    for (const issue of issues) {
      const existing = tasksByNumber.get(issue.number);
      if (!existing) {
        await state.upsertTask({
          issueNumber: issue.number,
          title: issue.title,
          status: 'ready',
          labels: issue.labels,
          assignees: issue.assignees,
        });
      } else if (
        existing.status === 'ready' &&
        (existing.title !== issue.title ||
          !sameList(existing.labels, issue.labels) ||
          !sameList(existing.assignees, issue.assignees))
      ) {
        await state.upsertTask({
          issueNumber: issue.number,
          title: issue.title,
          labels: issue.labels,
          assignees: issue.assignees,
        });
      }
    }

    // 1b. Prune ready tasks no longer discovered (issue closed or converted).
    // Nothing is invested in them.
    const discovered = new Set(issues.map((i) => i.number));
    for (const task of await state.getTasks()) {
      if (task.status === 'ready' && !discovered.has(task.issueNumber)) {
        await state.removeTask(task.issueNumber);
      }
    }

    // 2. Reconcile: non-active tasks whose branch now has an open PR -> pr_open.
    for (const task of await state.getTasks()) {
      if (g.active.has(task.issueNumber) || !task.branch) continue;
      if (
        task.status !== 'working' &&
        task.status !== 'needs_input' &&
        task.status !== 'committed' &&
        task.status !== 'failed'
      ) {
        continue;
      }
      try {
        const pr = await github.findOpenPrForBranch(task.branch);
        if (pr) {
          const merged = await state.upsertTask({
            issueNumber: task.issueNumber,
            status: 'pr_open',
            prNumber: pr.number,
            prUrl: pr.url,
            error: undefined,
            question: undefined,
          });
          if (merged.status !== task.status) {
            await github.setLabels(task.issueNumber, ['agent-pr']);
            await worktrees.removeWorktree(task.issueNumber).catch(() => {});
          }
        }
      } catch (err) {
        logError(`reconcile #${task.issueNumber}`, err);
      }
    }

    // NOTE: no autonomous claiming — sessions start only from the Start button.
  } finally {
    g.polling = false;
  }
}

/**
 * On a fresh process, tasks stuck in working/needs_input have no live session
 * (sessions do not survive a restart). Flip them to pr_open if their branch
 * already has a PR, otherwise to failed.
 */
async function recoverStaleTasks(): Promise<void> {
  for (const task of await state.getTasks()) {
    if (task.status !== 'working' && task.status !== 'needs_input') continue;
    try {
      const pr = task.branch ? await github.findOpenPrForBranch(task.branch) : null;
      if (pr) {
        await state.upsertTask({
          issueNumber: task.issueNumber,
          status: 'pr_open',
          prNumber: pr.number,
          prUrl: pr.url,
          question: undefined,
        });
        await github.setLabels(task.issueNumber, ['agent-pr']);
        await worktrees.removeWorktree(task.issueNumber).catch(() => {});
      } else {
        await state.upsertTask({
          issueNumber: task.issueNumber,
          status: 'failed',
          error: 'Orchestrator restarted while the session was running',
          question: undefined,
        });
        await github.setLabels(task.issueNumber, ['agent-failed']);
      }
    } catch (err) {
      logError(`recover #${task.issueNumber}`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Idempotently start the poll loop (called from route handlers on first request). */
export function ensureLoopStarted(): void {
  const g = loop();
  if (g.started) return;
  g.started = true;
  sessions.onSessionEvent(handleSessionEvent);
  g.interval = setInterval(() => {
    poll().catch((err) => logError('poll cycle', err));
  }, POLL_INTERVAL_MS);
  void (async () => {
    await recoverStaleTasks();
    await poll();
  })().catch((err) => logError('initial poll', err));
}

/** Run one poll cycle immediately (backs POST /api/poll and the "Poll now" button). */
export async function pollNow(): Promise<void> {
  ensureLoopStarted();
  await poll();
}


/** Manually start an agent on a ready issue (backs POST /api/tasks/[n]/start). */
export async function startIssue(issueNumber: number): Promise<void> {
  ensureLoopStarted();
  const task = await findTask(issueNumber);

  if (task?.status === 'working' || task?.status === 'needs_input') {
    throw new Error(`Issue #${issueNumber} already has an active session`);
  }
  if (task?.status === 'pr_open') {
    throw new Error(`Issue #${issueNumber} already has an open PR`);
  }
  if (task?.status === 'failed') {
    throw new Error(`Issue #${issueNumber} failed — use retry instead`);
  }

  let title = task?.title;
  if (!task) {
    const issue = await github.getIssue(issueNumber);
    title = issue.title;
    await state.upsertTask({
      issueNumber,
      title,
      status: 'ready',
      labels: issue.labels,
      assignees: issue.assignees,
    });
  }
  await claim(issueNumber, title || `Issue #${issueNumber}`);
}

/**
 * Push a committed issue's branch and open its PR (backs POST /api/tasks/[n]/push).
 * The ONLY path that ever pushes — always developer-triggered, never the agent.
 */
export async function pushIssue(issueNumber: number): Promise<void> {
  ensureLoopStarted();
  const task = await findTask(issueNumber);
  if (!task) {
    throw new Error(`Unknown issue #${issueNumber}`);
  }
  if (task.status !== 'committed') {
    throw new Error(`Issue #${issueNumber} is not committed (status: ${task.status})`);
  }
  if (!task.branch) {
    throw new Error(`Issue #${issueNumber} has no branch recorded`);
  }
  await worktrees.pushBranch(issueNumber);
  const pr = await github.createPullRequest(
    issueNumber,
    task.branch,
    task.title || `Issue #${issueNumber}`
  );
  await state.appendLog(issueNumber, {
    ts: new Date().toISOString(),
    kind: 'result',
    text: `Pushed ${task.branch} and opened PR: ${pr.url}`,
  });
  const merged = await state.upsertTask({
    issueNumber,
    status: 'pr_open',
    prNumber: pr.number,
    prUrl: pr.url,
  });
  await onStatusChange(issueNumber, merged);
}

/** Statuses the developer may set manually, with their GitHub label (null = clear all agent labels). */
const MANUAL_STATUS_LABEL = {
  ready: null,
  committed: 'agent-committed',
  failed: 'agent-failed',
} as const;

export type ManualStatus = keyof typeof MANUAL_STATUS_LABEL;

/**
 * Manually override a task's status (backs POST /api/tasks/[n]/status), e.g.
 * failed -> committed when the work is fine and only the finish was wrong.
 * Session-owned states (working/needs_input) cannot be set — stop first.
 */
export async function setIssueStatus(
  issueNumber: number,
  status: ManualStatus
): Promise<void> {
  ensureLoopStarted();
  const task = await findTask(issueNumber);
  if (!task) {
    throw new Error(`Unknown issue #${issueNumber}`);
  }
  if (task.status === status) return;
  if (task.status === 'working' || task.status === 'needs_input') {
    throw new Error(`Issue #${issueNumber} has an active session — stop it first`);
  }
  await state.upsertTask({
    issueNumber,
    status,
    error: status === 'failed' ? task.error : undefined,
    question: undefined,
  });
  const label = MANUAL_STATUS_LABEL[status];
  await github.setLabels(issueNumber, label ? [label] : []);
  await state.appendLog(issueNumber, {
    ts: new Date().toISOString(),
    kind: 'info',
    text: `Status manually set to ${status} by the developer`,
  });
}

/** Stop the agent on an issue (backs POST /api/tasks/[n]/stop). */
export async function stopIssue(issueNumber: number): Promise<void> {
  ensureLoopStarted();
  const g = loop();
  await sessions.stopSession(issueNumber);
  g.active.delete(issueNumber);
  const task = await findTask(issueNumber);
  if (task && (task.status === 'working' || task.status === 'needs_input')) {
    // Direct upsert (not via session events) — no failure comment for manual stops.
    await state.upsertTask({
      issueNumber,
      status: 'failed',
      error: 'Stopped by user',
      question: undefined,
    });
    await github.setLabels(issueNumber, ['agent-failed']);
    // Worktree is kept so retry can reuse it.
  }
}

/** Retry a failed issue (backs POST /api/tasks/[n]/retry) — re-claims it reusing its worktree. */
export async function retryIssue(issueNumber: number): Promise<void> {
  ensureLoopStarted();
  const task = await findTask(issueNumber);
  if (!task) {
    throw new Error(`Unknown issue #${issueNumber}`);
  }
  if (task.status !== 'failed') {
    throw new Error(`Issue #${issueNumber} is not failed (status: ${task.status})`);
  }
  await claim(issueNumber, task.title || `Issue #${issueNumber}`);
}
