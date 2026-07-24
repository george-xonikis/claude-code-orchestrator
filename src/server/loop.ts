import type { RepoInfo, Task } from '@/lib/types';
import { requireReviewerAgents } from './agents';
import { getExecutionConfig, setExecutionConfig } from './execution';
import * as github from './github';
import { loadRepos } from './repos';
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
 * ONE global interval polls EVERY registered repo — the registry is re-read
 * each tick, so newly added repos join automatically. All per-repo loop state
 * (active session set, polling/recovery flags) is keyed by repo id.
 *
 * The interval + wiring are lazily initialized behind a globalThis guard so
 * Next dev hot-reload doesn't duplicate the loop.
 */

/** How often the loop wakes to check each repo; per-repo polling is gated by config. */
const BASE_TICK_MS = 30_000;

/** Issues carrying this label must never be implemented by an agent. */
const NON_AGENT_LABEL = /^non[- ]?agent$/i;

interface RepoLoopState {
  polling: boolean;
  /** Restart recovery has run for this repo in this process. */
  recovered: boolean;
  /** Issues with a live session (working OR needs_input) — the slot count. */
  active: Set<number>;
  /** Epoch ms of the last GitHub poll (0 = never), for the per-repo poll interval. */
  lastPolledAt: number;
  /** Tasks auto-pickup has started in the current run (reset when it's re-enabled). */
  executedThisRun: number;
  /** Previous auto-pickup on/off, to detect a fresh run for the counter reset. */
  autoStartWas: boolean;
}

interface LoopGlobal {
  started: boolean;
  repos: Map<string, RepoLoopState>;
  interval: ReturnType<typeof setInterval> | null;
}

const globalRef = globalThis as typeof globalThis & {
  __orchestratorLoop?: LoopGlobal;
};

function loop(): LoopGlobal {
  if (!globalRef.__orchestratorLoop) {
    globalRef.__orchestratorLoop = {
      started: false,
      repos: new Map(),
      interval: null,
    };
  }
  return globalRef.__orchestratorLoop;
}

function repoLoop(repoId: string): RepoLoopState {
  const g = loop();
  let s = g.repos.get(repoId);
  if (!s) {
    s = {
      polling: false,
      recovered: false,
      active: new Set(),
      lastPolledAt: 0,
      executedThisRun: 0,
      autoStartWas: false,
    };
    g.repos.set(repoId, s);
  }
  return s;
}

function logError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[orchestrator] ${context}: ${message}`);
}

async function findTask(
  repo: RepoInfo,
  issueNumber: number
): Promise<Task | undefined> {
  return (await state.getTasks(repo.path)).find(
    (t) => t.issueNumber === issueNumber
  );
}

// ---------------------------------------------------------------------------
// Session events -> state + labels + worktree lifecycle
// ---------------------------------------------------------------------------

/** GitHub/worktree side effects when a task's status actually changes. */
async function onStatusChange(
  repo: RepoInfo,
  issueNumber: number,
  task: Task
): Promise<void> {
  const s = repoLoop(repo.id);
  switch (task.status) {
    case 'committed':
      // Session over, slot freed; the worktree stays until the developer pushes.
      s.active.delete(issueNumber);
      await github.setLabels(repo.path, issueNumber, ['agent-committed']);
      break;
    case 'pr_open':
      s.active.delete(issueNumber);
      await github.setLabels(repo.path, issueNumber, ['agent-pr']);
      await worktrees.removeWorktree(repo.path, issueNumber);
      break;
    case 'failed':
      s.active.delete(issueNumber);
      await github.setLabels(repo.path, issueNumber, ['agent-failed']);
      // Short reason only — never log dumps. Worktree is kept for retry.
      await github.commentOnIssue(
        repo.path,
        issueNumber,
        `Agent session failed: ${task.error ?? 'unknown error'}`
      );
      break;
    case 'needs_input':
      await github.setLabels(repo.path, issueNumber, ['agent-needs-input']);
      break;
    case 'working':
      // Resume after needs_input (initial claim sets the label itself).
      await github.setLabels(repo.path, issueNumber, ['agent-working']);
      break;
    default:
      break;
  }
}

function handleSessionEvent(event: sessions.SessionEvent): void {
  void (async () => {
    const { repo, issueNumber } = event;
    if (event.log) {
      await state.appendLog(repo.path, issueNumber, event.log);
    }
    if (event.patch) {
      const prev = await findTask(repo, issueNumber);
      const merged = await state.upsertTask(repo.path, {
        issueNumber,
        ...event.patch,
      });
      if (prev?.status !== merged.status) {
        await onStatusChange(repo, issueNumber, merged);
        // A finished session (committed/pr_open/failed) frees a slot — refill
        // auto-pickup immediately instead of waiting for the next poll tick.
        if (['committed', 'pr_open', 'failed'].includes(merged.status)) {
          await autoStart(repo, repoLoop(repo.id)).catch((err) =>
            logError(`auto-pickup after ${repo.name}#${issueNumber}`, err)
          );
        }
      }
    }
  })().catch((err) =>
    logError(`session event for ${event.repo.name}#${event.issueNumber}`, err)
  );
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** Claim an issue: label agent-working, create/reuse worktree, start the session. */
async function claim(
  repo: RepoInfo,
  issueNumber: number,
  title: string,
  model?: string,
  useWorkflow = false
): Promise<void> {
  const s = repoLoop(repo.id);
  s.active.add(issueNumber); // Reserve the slot up front.
  try {
    // Gate: the session's configured reviewer agents must exist before we start
    // (throws here → caught below → task failed + issue comment). Validating
    // before the worktree avoids creating a doomed one.
    const { reviewerAgents } = await getExecutionConfig(repo);
    await requireReviewerAgents(repo, reviewerAgents);
    await github.setLabels(repo.path, issueNumber, ['agent-working']);
    const wt = await worktrees.createWorktree(repo.path, issueNumber);
    await state.upsertTask(repo.path, {
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
    await sessions.startSession(
      repo,
      issueNumber,
      wt.path,
      wt.branch,
      model,
      useWorkflow,
      reviewerAgents
    );
  } catch (err) {
    s.active.delete(issueNumber);
    const message = err instanceof Error ? err.message : String(err);
    // Into the log stream too — a claim failure must never be invisible there.
    await state
      .appendLog(repo.path, issueNumber, {
        ts: new Date().toISOString(),
        kind: 'error',
        text: `Could not start session: ${message}`,
      })
      .catch(() => {});
    await state
      .upsertTask(repo.path, { issueNumber, status: 'failed', error: message })
      .catch(() => {});
    await github
      .setLabels(repo.path, issueNumber, ['agent-failed'])
      .catch(() => {});
    await github
      .commentOnIssue(
        repo.path,
        issueNumber,
        `Agent orchestrator could not start a session: ${message}`
      )
      .catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

async function poll(repo: RepoInfo): Promise<void> {
  const s = repoLoop(repo.id);
  if (s.polling) return; // A cycle is already running for this repo.
  s.polling = true;
  try {
    // 1. Discover all open issues -> upsert as status ready.
    const issues = await github.listOpenIssues(repo.path);
    const tasksByNumber = new Map(
      (await state.getTasks(repo.path)).map((t) => [t.issueNumber, t])
    );
    const sameList = (a: string[] | undefined, b: string[]) =>
      JSON.stringify(a ?? []) === JSON.stringify(b);
    for (const issue of issues) {
      const existing = tasksByNumber.get(issue.number);
      if (!existing) {
        await state.upsertTask(repo.path, {
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
        await state.upsertTask(repo.path, {
          issueNumber: issue.number,
          title: issue.title,
          labels: issue.labels,
          assignees: issue.assignees,
        });
      }
    }

    // 1b. Prune tasks whose issue is no longer open — it was closed or, for a
    // pr_open task, its PR merged (our PR bodies "Closes #N" auto-close it).
    // Skip live sessions (working/needs_input) so an in-flight agent is never
    // dropped mid-run. For tasks with invested work (committed/pr_open/failed)
    // confirm the issue is actually closed — the open-issue list is capped, so
    // "not listed" alone isn't proof it's gone.
    const discovered = new Set(issues.map((i) => i.number));
    for (const task of await state.getTasks(repo.path)) {
      const liveSession =
        task.status === 'working' || task.status === 'needs_input' || s.active.has(task.issueNumber);
      if (liveSession || discovered.has(task.issueNumber)) continue;
      const gone =
        task.status === 'ready' || (await github.issueIsClosed(repo.path, task.issueNumber));
      if (gone) await state.removeTask(repo.path, task.issueNumber);
    }

    // 2. Reconcile: non-active tasks whose branch now has an open PR -> pr_open.
    for (const task of await state.getTasks(repo.path)) {
      if (s.active.has(task.issueNumber) || !task.branch) continue;
      if (
        task.status !== 'working' &&
        task.status !== 'needs_input' &&
        task.status !== 'committed' &&
        task.status !== 'failed'
      ) {
        continue;
      }
      try {
        const pr = await github.findOpenPrForBranch(repo.path, task.branch);
        if (pr) {
          const merged = await state.upsertTask(repo.path, {
            issueNumber: task.issueNumber,
            status: 'pr_open',
            prNumber: pr.number,
            prUrl: pr.url,
            error: undefined,
            question: undefined,
          });
          if (merged.status !== task.status) {
            await github.setLabels(repo.path, task.issueNumber, ['agent-pr']);
            await worktrees
              .removeWorktree(repo.path, task.issueNumber)
              .catch(() => {});
          }
        }
      } catch (err) {
        logError(`reconcile ${repo.name}#${task.issueNumber}`, err);
      }
    }
    // NOTE: auto-pickup runs separately (every tick), independent of GitHub polling.
  } finally {
    s.polling = false;
  }
}

/**
 * Auto-pickup: while under the per-repo concurrency cap, claim ready issues
 * (skipping `non-agent`), draining them in the configured queue order (oldest
 * issue first by default). No-op unless the repo has auto-pickup on and a GitHub
 * URL. `claim()` reserves the slot synchronously via `s.active.add`, so the cap
 * holds across iterations. Turning auto-pickup off just stops new pickups —
 * in-flight sessions keep running (never cancelled), and the merge gate stays
 * human: this only takes work as far as a commit.
 */
async function autoStart(repo: RepoInfo, s: RepoLoopState): Promise<void> {
  if (!repo.htmlUrl) return;
  const { autoStart: enabled, maxActive, queueOrder, tasksPerRun } = await getExecutionConfig(repo);

  // A fresh run (off -> on) resets the per-run task counter.
  if (enabled && !s.autoStartWas) s.executedThisRun = 0;
  s.autoStartWas = enabled;
  if (!enabled) return;

  // Hit the per-run cap → turn auto-pickup off (in-flight sessions keep running).
  const capReached = () => tasksPerRun !== null && s.executedThisRun >= tasksPerRun;
  if (capReached()) {
    await setExecutionConfig(repo, { autoStart: false }).catch(() => {});
    s.autoStartWas = false;
    return;
  }
  if (s.active.size >= maxActive) return;

  const queue = (await state.getTasks(repo.path))
    .filter((task) => {
      if (task.status !== 'ready' || s.active.has(task.issueNumber)) return false;
      return !(task.labels ?? []).some((label) => NON_AGENT_LABEL.test(label));
    })
    // Issue numbers are monotonic, so ascending = oldest first.
    .sort((a, b) =>
      queueOrder === 'newest' ? b.issueNumber - a.issueNumber : a.issueNumber - b.issueNumber
    );

  for (const task of queue) {
    if (s.active.size >= maxActive || capReached()) break;
    try {
      await claim(
        repo,
        task.issueNumber,
        task.title || `Issue #${task.issueNumber}`,
        task.preferredModel,
        task.useWorkflow ?? false
      );
      s.executedThisRun += 1;
    } catch (err) {
      // claim() already records the failure on the task; keep draining the queue.
      logError(`auto-pickup ${repo.name}#${task.issueNumber}`, err);
    }
  }

  // If that filled the run's budget, stop auto-pickup so it doesn't keep going.
  if (capReached()) {
    await setExecutionConfig(repo, { autoStart: false }).catch(() => {});
    s.autoStartWas = false;
  }
}

/**
 * On a fresh process, tasks stuck in working/needs_input have no live session
 * (sessions do not survive a restart). Flip them to pr_open if their branch
 * already has a PR, otherwise to failed. Runs once per repo per process.
 */
async function recoverStaleTasks(repo: RepoInfo): Promise<void> {
  const s = repoLoop(repo.id);
  if (s.recovered) return;
  s.recovered = true;
  for (const task of await state.getTasks(repo.path)) {
    if (task.status !== 'working' && task.status !== 'needs_input') continue;
    try {
      const pr = task.branch
        ? await github.findOpenPrForBranch(repo.path, task.branch)
        : null;
      if (pr) {
        await state.upsertTask(repo.path, {
          issueNumber: task.issueNumber,
          status: 'pr_open',
          prNumber: pr.number,
          prUrl: pr.url,
          question: undefined,
        });
        await github.setLabels(repo.path, task.issueNumber, ['agent-pr']);
        await worktrees
          .removeWorktree(repo.path, task.issueNumber)
          .catch(() => {});
      } else {
        await state.upsertTask(repo.path, {
          issueNumber: task.issueNumber,
          status: 'failed',
          error: 'Orchestrator restarted while the session was running',
          question: undefined,
        });
        await github.setLabels(repo.path, task.issueNumber, ['agent-failed']);
      }
    } catch (err) {
      logError(`recover ${repo.name}#${task.issueNumber}`, err);
    }
  }
}

/** One tick: recover (once per repo) + poll each repo whose interval has elapsed. */
async function pollAllRepos(): Promise<void> {
  const repos = await loadRepos();
  const now = Date.now();
  await Promise.all(
    repos.map(async (repo) => {
      try {
        await recoverStaleTasks(repo);
        const s = repoLoop(repo.id);
        const { pollMinutes } = await getExecutionConfig(repo);
        // Poll GitHub only when due (skip entirely when off)...
        if (pollMinutes !== null && now - s.lastPolledAt >= pollMinutes * 60_000) {
          s.lastPolledAt = now;
          await poll(repo);
        }
        // ...but keep auto-pickup draining the queue every tick, regardless.
        await autoStart(repo, s);
      } catch (err) {
        logError(`poll cycle for ${repo.name}`, err);
      }
    })
  );
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
    pollAllRepos().catch((err) => logError('poll cycle', err));
  }, BASE_TICK_MS);
  void pollAllRepos().catch((err) => logError('initial poll', err));
}

/** Run one poll cycle for a repo immediately (backs POST /api/poll and the "Poll now" button). */
export async function pollNow(repo: RepoInfo): Promise<void> {
  ensureLoopStarted();
  await recoverStaleTasks(repo);
  const s = repoLoop(repo.id);
  s.lastPolledAt = Date.now(); // resets the per-repo interval clock
  await poll(repo);
  await autoStart(repo, s); // pick up straight away (also backs "Start agents")
}


/** Manually start an agent on a ready issue (backs POST /api/tasks/[n]/start). */
export async function startIssue(
  repo: RepoInfo,
  issueNumber: number,
  model?: string
): Promise<void> {
  ensureLoopStarted();
  const task = await findTask(repo, issueNumber);

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
  let labels = task?.labels;
  if (!task) {
    const issue = await github.getIssue(repo.path, issueNumber);
    title = issue.title;
    labels = issue.labels;
    await state.upsertTask(repo.path, {
      issueNumber,
      title,
      status: 'ready',
      labels: issue.labels,
      assignees: issue.assignees,
    });
  }
  if ((labels ?? []).some((label) => NON_AGENT_LABEL.test(label))) {
    throw new Error(
      `Issue #${issueNumber} is labeled "Non agent" — it must be implemented by a human`
    );
  }
  await claim(
    repo,
    issueNumber,
    title || `Issue #${issueNumber}`,
    model ?? task?.preferredModel,
    task?.useWorkflow ?? false
  );
}

/**
 * Push a committed issue's branch and open its PR (backs POST /api/tasks/[n]/push).
 * The ONLY path that ever pushes — always developer-triggered, never the agent.
 */
export async function pushIssue(
  repo: RepoInfo,
  issueNumber: number
): Promise<void> {
  ensureLoopStarted();
  const task = await findTask(repo, issueNumber);
  if (!task) {
    throw new Error(`Unknown issue #${issueNumber}`);
  }
  if (task.status !== 'committed') {
    throw new Error(`Issue #${issueNumber} is not committed (status: ${task.status})`);
  }
  if (!task.branch) {
    throw new Error(`Issue #${issueNumber} has no branch recorded`);
  }
  // The agent can finish cleanly without committing (e.g. it decided no change
  // was needed). Pushing that opens a PR with no diff — GitHub rejects it with a
  // cryptic "No commits between…". Catch it here with a clear, actionable state.
  if ((await worktrees.commitsAhead(repo.path, issueNumber)) === 0) {
    const message = 'The agent finished without committing any changes — nothing to push.';
    const merged = await state.upsertTask(repo.path, {
      issueNumber,
      status: 'failed',
      error: message,
    });
    await onStatusChange(repo, issueNumber, merged).catch(() => {});
    throw new Error(message);
  }
  await worktrees.pushBranch(repo.path, issueNumber);
  const pr = await github.createPullRequest(
    repo.path,
    issueNumber,
    task.branch,
    task.title || `Issue #${issueNumber}`
  );
  await state.appendLog(repo.path, issueNumber, {
    ts: new Date().toISOString(),
    kind: 'result',
    text: `Pushed ${task.branch} and opened PR: ${pr.url}`,
  });
  const merged = await state.upsertTask(repo.path, {
    issueNumber,
    status: 'pr_open',
    prNumber: pr.number,
    prUrl: pr.url,
  });
  await onStatusChange(repo, issueNumber, merged);
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
  repo: RepoInfo,
  issueNumber: number,
  status: ManualStatus
): Promise<void> {
  ensureLoopStarted();
  const task = await findTask(repo, issueNumber);
  if (!task) {
    throw new Error(`Unknown issue #${issueNumber}`);
  }
  if (task.status === status) return;
  if (task.status === 'working' || task.status === 'needs_input') {
    throw new Error(`Issue #${issueNumber} has an active session — stop it first`);
  }
  await state.upsertTask(repo.path, {
    issueNumber,
    status,
    error: status === 'failed' ? task.error : undefined,
    question: undefined,
  });
  const label = MANUAL_STATUS_LABEL[status];
  await github.setLabels(repo.path, issueNumber, label ? [label] : []);
  await state.appendLog(repo.path, issueNumber, {
    ts: new Date().toISOString(),
    kind: 'info',
    text: `Status manually set to ${status} by the developer`,
  });
}

/**
 * Save ticket settings from the modal: title/body go to the GitHub issue,
 * model preference and workflow toggle live on the local task.
 */
export async function saveTicketSettings(
  repo: RepoInfo,
  issueNumber: number,
  patch: { title?: string; body?: string; preferredModel?: string; useWorkflow?: boolean }
): Promise<void> {
  ensureLoopStarted();
  if (patch.title !== undefined || patch.body !== undefined) {
    await github.editIssue(repo.path, issueNumber, { title: patch.title, body: patch.body });
  }
  await state.upsertTask(repo.path, {
    issueNumber,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.preferredModel !== undefined ? { preferredModel: patch.preferredModel } : {}),
    ...(patch.useWorkflow !== undefined ? { useWorkflow: patch.useWorkflow } : {}),
  });
}

/** Stop the agent on an issue (backs POST /api/tasks/[n]/stop). */
export async function stopIssue(
  repo: RepoInfo,
  issueNumber: number
): Promise<void> {
  ensureLoopStarted();
  const s = repoLoop(repo.id);
  await sessions.stopSession(repo, issueNumber);
  s.active.delete(issueNumber);
  const task = await findTask(repo, issueNumber);
  if (task && (task.status === 'working' || task.status === 'needs_input')) {
    // Direct upsert (not via session events) — no failure comment for manual stops.
    await state.upsertTask(repo.path, {
      issueNumber,
      status: 'failed',
      error: 'Stopped by user',
      question: undefined,
    });
    await github.setLabels(repo.path, issueNumber, ['agent-failed']);
    // Worktree is kept so retry can reuse it.
  }
}

/** Retry a failed issue (backs POST /api/tasks/[n]/retry) — re-claims it reusing its worktree. */
export async function retryIssue(
  repo: RepoInfo,
  issueNumber: number
): Promise<void> {
  ensureLoopStarted();
  const task = await findTask(repo, issueNumber);
  if (!task) {
    throw new Error(`Unknown issue #${issueNumber}`);
  }
  if (task.status !== 'failed') {
    throw new Error(`Issue #${issueNumber} is not failed (status: ${task.status})`);
  }
  // A failed task's session is dead by definition — kill any stale registry
  // entry so retry can never trip over "a session is already running".
  await sessions.stopSession(repo, issueNumber);
  // Retry prefers the ticket's configured model, else the one it last ran on.
  await claim(
    repo,
    issueNumber,
    task.title || `Issue #${issueNumber}`,
    task.preferredModel ?? task.model,
    task.useWorkflow ?? false
  );
}
