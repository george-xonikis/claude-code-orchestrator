/**
 * CASE: Conflict-resolution session — re-opens an issue's worktree to rebase
 * its PR branch onto the moved default branch and resolve the conflicts.
 *
 * Same philosophy as the implementation session: Hydra states the situation
 * (the envelope); the repository's own rules govern HOW the work is done. The
 * method default is REBASE (agent branches are single-author, so a
 * force-with-lease push is safe) — but a repo whose rules prescribe otherwise
 * wins. Nothing about the repo's skills/agents is injected — the Claude Code
 * runtime surfaces them natively inside the session.
 *
 * The wording lives in DEFAULT_CONFLICT_TEMPLATE; a repo can override it from
 * Settings → Prompts (.claude-hydra/prompts/conflict.md), in which case the
 * override is passed in as `template`.
 */

import { renderTemplate } from '@/server/core/render';

export const DEFAULT_CONFLICT_TEMPLATE = `You are an autonomous engineering agent. Pull request #{{prNumber}} (branch \`{{branch}}\`, implementing GitHub issue #{{issueNumber}}) has merge conflicts with \`{{baseBranch}}\`. Your job is to resolve them.

Your working directory is the git worktree at {{worktreePath}}, already checked out on \`{{branch}}\`. Do all work there — other sessions may be running in sibling worktrees.

Context first: run \`gh pr view {{prNumber}}\` and \`gh issue view {{issueNumber}} --comments\` to understand what this branch is meant to do, and inspect the conflicting changes on \`{{baseBranch}}\` to understand what it now does.

## Authority

This repository's own rules govern everything about HOW you work: its CLAUDE.md, its skills, its agents, and its settings. The orchestrator that launched you imposes no rules of its own — follow the repository's.

{{#workflowHint}}
Hint: for large or multi-part tasks, you may orchestrate — fan out subagents for independent parts and integrate their results yourself.
{{/workflowHint}}

## Task

1. \`git fetch origin\`, then rebase this branch onto \`origin/{{baseBranch}}\` (unless the repository's rules prescribe a different conflict-resolution method — then follow those).
2. Resolve every conflict by preserving the INTENT of both sides: this branch's fix for issue #{{issueNumber}} AND whatever \`{{baseBranch}}\` changed. Never resolve by blindly taking one side. If both sides changed the same behavior, integrate them; read surrounding code until you understand why each side made its change.
3. Verify per the repository's rules that the result still works, and that the rebase is fully complete (no leftover conflict markers, no in-progress rebase state).
4. The rebased branch stays local: the developer force-pushes (with lease) the update from the orchestrator dashboard. If this repository's rules allow you to push yourself, use \`git push --force-with-lease\`.

If — and only if — you are blocked on a decision that only the developer can make (e.g. the two sides are genuinely irreconcilable), call the \`ask_user\` tool once with one specific question, then continue with the answer. Otherwise work fully autonomously.`;

export function buildConflictPrompt(
  issueNumber: number,
  prNumber: number,
  worktreePath: string,
  branch: string,
  baseBranch: string,
  useWorkflow = false,
  template: string = DEFAULT_CONFLICT_TEMPLATE
): string {
  return renderTemplate(template, {
    issueNumber: String(issueNumber),
    prNumber: String(prNumber),
    worktreePath,
    branch,
    baseBranch,
    workflowHint: useWorkflow ? 'true' : '',
  });
}
