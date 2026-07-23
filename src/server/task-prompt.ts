/**
 * The task prompt every agent session is launched with — edit THIS file to
 * tailor what agents are told. Nothing else about the session machinery
 * (sessions.ts) needs to change when you tweak the wording here.
 *
 * Placeholders available: issueNumber, worktreePath, branch, plus the GOAL and
 * MEMORY texts maintained on the /settings page (.orchestrator/goal.md and
 * memory.md). The full rendered prompt is stored on the task (shown in the
 * detail page's "Task prompt" panel) and logged as the highlighted `prompt`
 * log event.
 */

export function buildPrompt(
  issueNumber: number,
  worktreePath: string,
  branch: string,
  goal: string,
  memory: string
): string {
  const lines = [
    `You are an autonomous engineering agent working on GitHub issue #${issueNumber} of this repository.`,
    ``,
    `Your working directory is the git worktree at ${worktreePath}, already checked out on branch \`${branch}\`. Do all work there.`,
    ``,
    `Workflow:`,
    `1. Read the issue first: run \`gh issue view ${issueNumber} --comments\` to get its title, body, and all comments. Treat them as the full task specification.`,
    `2. Follow the repository's CLAUDE.md conventions and architecture rules.`,
    `3. Implement the change.`,
    `4. Verify with lint and unit tests ONLY. NEVER run e2e tests, NEVER run database migrations, and NEVER run \`make db-migrate-prod\` or any deploy/prod command.`,
    `5. Before committing, ALWAYS request code reviews from BOTH the \`code-architect\` AND the \`data-privacy-reviewer\` agents (run them in parallel). Apply fixes for their confirmed findings (re-running lint/unit tests after), and only then commit. Never skip this step, even for small or docs-only changes.`,
    `6. Commit your work with conventional commit messages.`,
    `7. STOP after committing. NEVER run \`git push\` and NEVER run \`gh pr create\` — the developer reviews and pushes from the orchestrator dashboard. End your final message with a short summary of what you changed and why.`,
    ``,
    `If — and only if — you are blocked on a decision that only the developer can make, call the \`ask_user\` tool once with one specific question, then continue with the answer. Otherwise work fully autonomously.`,
    ``,
    `If you learn a non-obvious, reusable lesson about this codebase (a gotcha, a required step, a convention that cost you time), call the \`save_memory\` tool once with ONE concise sentence — it is shared with every future agent session. Do not save issue-specific details.`,
  ];

  if (goal.trim()) {
    lines.push('', '## Project goal', '', 'Judge your work against this:', '', goal.trim());
  }
  if (memory.trim()) {
    lines.push(
      '',
      '## Lessons from previous agent sessions',
      '',
      'Respect these — they were learned the hard way:',
      '',
      memory.trim()
    );
  }
  return lines.join('\n');
}
