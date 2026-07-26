import type { RepoInfo, Task } from '@/lib/types';
import * as github from '@/server/core/github';
import { getExecutionConfig } from '@/server/execution/config';
import { buildConflictPrompt } from '@/server/execution/prompts';
import * as sessions from '@/server/execution/sessions';
import * as state from '@/server/state/state';
import * as worktrees from '@/server/core/worktrees';
import { readPromptTemplate } from '@/server/knowledge/prompt-templates';
import { releaseSlot, reserveSlot } from '@/server/execution/flows/slots';
import type { OutcomeMapper } from '@/server/execution/flows/types';

/**
 * CONFLICT FLOW — the whole story of "an issue's open PR conflicts with the
 * default branch" in one file: detection (merge-state refresh during polls),
 * the resolution session (rebase in a recreated worktree), and publishing the
 * fix (force-with-lease push over the existing PR).
 *
 * The IMPLEMENTATION flow (./implementation.ts) is this file's sibling for
 * fresh issue work.
 */

/**
 * A finished resolution session always lands as 'committed': the PR already
 * exists, so the PR URL the agent inevitably mentions is NOT a new PR — the
 * rebased branch waits for the dashboard's force-with-lease push.
 */
const mapOutcome: OutcomeMapper = (outcome) => {
  if (!outcome.success) {
    return {
      patch: { status: 'failed', error: outcome.errorText },
      logKind: 'error',
      logText: `Session failed: ${outcome.errorText ?? 'unknown error'}`,
    };
  }
  return {
    patch: { status: 'committed' },
    logKind: 'result',
    logText: 'Conflicts resolved locally — push the update from the dashboard',
  };
};

/**
 * Refresh the merge state of every task carrying an open PR (pr_open, plus
 * failed resolution sessions so their badge stays truthful). CONFLICTING sets
 * prConflicts; MERGEABLE clears it; UNKNOWN (GitHub still computing) leaves
 * the last known state untouched. Called from the loop's poll cycle.
 */
export async function refreshMergeStates(
  repo: RepoInfo,
  onError: (context: string, err: unknown) => void
): Promise<void> {
  for (const task of await state.getTasks(repo.path)) {
    if (!task.prNumber) continue;
    if (task.status !== 'pr_open' && task.status !== 'failed') continue;
    try {
      const mergeable = await github.getPrMergeable(repo.path, task.prNumber);
      if (mergeable === 'UNKNOWN') continue;
      const conflicts = mergeable === 'CONFLICTING';
      if (conflicts !== (task.prConflicts ?? false)) {
        await state.upsertTask(repo.path, {
          issueNumber: task.issueNumber,
          prConflicts: conflicts ? true : undefined,
        });
      }
    } catch (err) {
      onError(`merge state ${repo.name}#${task.issueNumber}`, err);
    }
  }
}

/**
 * Start a conflict-resolution session for a task's existing PR: recreate the
 * worktree on the surviving PR branch and launch a session prompted to rebase
 * onto the default branch and resolve. Mirrors claimIssue's slot + failure
 * handling (no GitHub comment — the failure is visible on the PR card).
 */
export async function startResolve(repo: RepoInfo, task: Task): Promise<void> {
  const { issueNumber } = task;
  if (!task.prNumber) {
    throw new Error(`Issue #${issueNumber} has no PR recorded`);
  }
  reserveSlot(repo.id, issueNumber); // Synchronous, so concurrency caps hold.
  try {
    const { executionModel } = await getExecutionConfig(repo);
    const baseBranch = await worktrees.getDefaultBranch(repo.path);
    await github.setLabels(repo.path, issueNumber, ['agent-working']);
    const wt = await worktrees.createWorktree(repo.path, issueNumber);
    await state.upsertTask(repo.path, {
      issueNumber,
      status: 'working',
      worktreePath: wt.path,
      branch: wt.branch,
      error: undefined,
      question: undefined,
      // prNumber/prUrl/prConflicts stay — this session serves the existing PR.
    });
    const template = await readPromptTemplate('conflict');
    await sessions.startSession({
      repo,
      issueNumber,
      worktreePath: wt.path,
      branch: wt.branch,
      model: task.preferredModel ?? task.model ?? executionModel,
      taskPrompt: buildConflictPrompt(
        issueNumber,
        task.prNumber,
        wt.path,
        wt.branch,
        baseBranch,
        // The ticket's dynamic-workflow toggle carries over to conflict work.
        task.useWorkflow ?? false,
        template
      ),
      mapOutcome,
      launchLog: `Conflict-resolution session launched on ${wt.branch} (PR #${task.prNumber})`,
    });
  } catch (err) {
    releaseSlot(repo.id, issueNumber);
    const message = err instanceof Error ? err.message : String(err);
    await state
      .appendLog(repo.path, issueNumber, {
        ts: new Date().toISOString(),
        kind: 'error',
        text: `Could not start conflict-resolution session: ${message}`,
      })
      .catch(() => {});
    await state
      .upsertTask(repo.path, { issueNumber, status: 'failed', error: message })
      .catch(() => {});
    await github
      .setLabels(repo.path, issueNumber, ['agent-failed'])
      .catch(() => {});
    throw err;
  }
}

/**
 * Publish a finished resolution: force-push the rebased branch over the
 * existing PR (safe: agent branches are single-author, and the lease still
 * refuses if the remote moved unexpectedly). Returns the merged task; the
 * caller applies label/worktree side effects.
 */
export async function pushUpdate(repo: RepoInfo, task: Task): Promise<Task> {
  const { issueNumber } = task;
  await worktrees.pushBranch(repo.path, issueNumber, { forceWithLease: true });
  await state.appendLog(repo.path, issueNumber, {
    ts: new Date().toISOString(),
    kind: 'result',
    text: `Force-pushed rebased ${task.branch} to PR #${task.prNumber}`,
  });
  return state.upsertTask(repo.path, {
    issueNumber,
    status: 'pr_open',
    prConflicts: undefined,
  });
}
