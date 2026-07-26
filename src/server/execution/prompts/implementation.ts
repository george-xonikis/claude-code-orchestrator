/**
 * CASE: Implementation session — the autonomous agent that works a GitHub issue.
 *
 * `buildPrompt` renders the task prompt every agent session is launched with.
 * The wording lives in DEFAULT_IMPLEMENTATION_TEMPLATE below; a repo can
 * override it wholesale from Settings → Prompts (stored in
 * .claude-hydra/prompts/implementation.md), in which case the override is
 * passed in as `template`.
 *
 * PHILOSOPHY: Hydra manages sessions; the REPOSITORY governs the work. The
 * prompt states the session envelope (issue, worktree, branch) and defers
 * everything about HOW to work — conventions, procedures, reviews, whether to
 * push — to the repo's own rules: CLAUDE.md, .claude/skills/, .claude/agents/,
 * and .claude/settings.json permissions. Hydra enforces nothing itself, and it
 * injects NOTHING about the repo's skills/agents — the Claude Code runtime
 * surfaces them natively inside the session.
 *
 * The tool description below is the model-facing text for the `ask_user` MCP
 * tool the session exposes. The full rendered prompt is stored on the task
 * (shown in the detail page's "Task prompt" panel) and logged as the
 * highlighted `prompt` log event.
 */

import { renderTemplate } from '@/server/core/render';

export const DEFAULT_IMPLEMENTATION_TEMPLATE = `You are an autonomous engineering agent working on GitHub issue #{{issueNumber}} of this repository.

Your working directory is the git worktree at {{worktreePath}}, already checked out on branch \`{{branch}}\`. Do all work there — other sessions may be running in sibling worktrees.

Read the issue first: run \`gh issue view {{issueNumber}} --comments\` to get its title, body, and all comments. Treat them as the full task specification.

## Authority

This repository's own rules govern everything about HOW you work: its CLAUDE.md, its skills, its agents, and its settings. The orchestrator that launched you imposes no rules of its own — follow the repository's.

{{#workflowHint}}
Hint: for large or multi-part tasks, you may orchestrate — fan out subagents for independent parts and integrate their results yourself.
{{/workflowHint}}

{{#productMap}}
Before committing, update the product map at docs/product-map.md to reflect what your change adds or alters — it is committed together with your work.
{{/productMap}}

When your work is done, commit it (following the repository's conventions). If you have not pushed or opened a PR yourself by the end of the session, the developer can review, push, and open the PR from the orchestrator dashboard.

If — and only if — you are blocked on a decision that only the developer can make, call the \`ask_user\` tool once with one specific question, then continue with the answer. Otherwise work fully autonomously.`;

export function buildPrompt(
  issueNumber: number,
  worktreePath: string,
  branch: string,
  useWorkflow = false,
  productMapEnabled = false,
  template: string = DEFAULT_IMPLEMENTATION_TEMPLATE
): string {
  return renderTemplate(template, {
    issueNumber: String(issueNumber),
    worktreePath,
    branch,
    workflowHint: useWorkflow ? 'true' : '',
    productMap: productMapEnabled ? 'true' : '',
  });
}

/** `ask_user` MCP tool — lets the agent pause for one blocking developer decision. */
export const ASK_USER_TOOL_DESCRIPTION =
  'Ask the developer a single blocking question when you cannot proceed without their decision. The session pauses until they answer from the dashboard.';
export const ASK_USER_QUESTION_DESCRIPTION = 'One specific question for the developer';
