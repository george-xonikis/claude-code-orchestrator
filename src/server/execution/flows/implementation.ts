import type { RepoInfo, Task } from '@/lib/types';
import * as github from '@/server/core/github';
import { getExecutionConfig } from '@/server/execution/config';
import { buildPrompt } from '@/server/execution/prompts';
import * as sessions from '@/server/execution/sessions';
import * as state from '@/server/state/state';
import * as worktrees from '@/server/core/worktrees';
import { readPromptTemplate } from '@/server/knowledge/prompt-templates';
import { getBriefAgent } from '@/server/knowledge/settings';
import { releaseSlot, reserveSlot } from '@/server/execution/flows/slots';
import type { OutcomeMapper } from '@/server/execution/flows/types';

/**
 * IMPLEMENTATION FLOW — the whole story of "an agent works a GitHub issue" in
 * one file: how a session starts (claim), how its outcome maps to a task
 * status, and how finished work is published (push + open a new PR).
 *
 * The loop (loop.ts) only schedules; the runtime (sessions.ts) only runs. The
 * CONFLICT flow (./conflict.ts) is this file's sibling for existing PRs.
 */

/**
 * A finished implementation session:
 * - success + a PR URL seen  -> pr_open (the repo's rules let the agent open it)
 * - success, no PR           -> committed, awaiting the dashboard's push
 * - failure                  -> failed, with the error recorded
 */
const mapOutcome: OutcomeMapper = (outcome) => {
  if (!outcome.success) {
    return {
      patch: { status: 'failed', error: outcome.errorText },
      logKind: 'error',
      logText: `Session failed: ${outcome.errorText ?? 'unknown error'}`,
    };
  }
  if (outcome.prUrl) {
    return {
      patch: { status: 'pr_open', prUrl: outcome.prUrl, prNumber: outcome.prNumber },
      logKind: 'result',
      logText: `PR opened: ${outcome.prUrl}`,
    };
  }
  return {
    patch: { status: 'committed' },
    logKind: 'result',
    logText: 'Work committed locally — push & open the PR from the dashboard',
  };
};

/** Claim an issue: label agent-working, create/reuse its worktree, launch the session. */
export async function claimIssue(
  repo: RepoInfo,
  issueNumber: number,
  title: string,
  model?: string,
  useWorkflow = false
): Promise<void> {
  reserveSlot(repo.id, issueNumber); // Synchronous, so concurrency caps hold.
  try {
    const { executionModel } = await getExecutionConfig(repo);
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
      prConflicts: undefined,
    });
    const template = await readPromptTemplate('implementation');
    // Product map is opt-in: enabled iff a brief-maintainer agent is assigned.
    // .catch guards the claim path — a settings read failure must never block work.
    const productMapEnabled =
      (await getBriefAgent(repo.path).catch(() => null)) !== null;
    await sessions.startSession({
      repo,
      issueNumber,
      worktreePath: wt.path,
      branch: wt.branch,
      // The ticket's own model wins; otherwise the repo's configured default.
      model: model ?? executionModel,
      taskPrompt: buildPrompt(
        issueNumber,
        wt.path,
        wt.branch,
        useWorkflow,
        productMapEnabled,
        template
      ),
      mapOutcome,
      launchLog: `Agent session launched on ${wt.branch}`,
    });
  } catch (err) {
    releaseSlot(repo.id, issueNumber);
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

/**
 * Publish a committed task: push its branch and open a NEW pull request.
 * Returns the merged task; the caller (loop.ts) applies label/worktree side
 * effects via its status-change handler.
 */
export async function pushNewPr(repo: RepoInfo, task: Task): Promise<Task> {
  const { issueNumber } = task;
  if (!task.branch) {
    throw new Error(`Issue #${issueNumber} has no branch recorded`);
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
  return state.upsertTask(repo.path, {
    issueNumber,
    status: 'pr_open',
    prNumber: pr.number,
    prUrl: pr.url,
  });
}
