# Claude Hydra

![Claude Hydra — multi-agent orchestration](public/hydra-logo.png)

Local dashboard that runs autonomous Claude Code agents against your repos' GitHub issues: a kanban of every open issue, one-click agent sessions in isolated git worktrees, planning agents that propose new tasks toward your goal, and a review-then-push gate so nothing reaches GitHub without you. Runs on your machine, never deployed.

Works with any local git repository that has a GitHub remote. Add repos from the dashboard and switch between them; the fleet overview shows agent status across all of them at a glance. Everything Hydra tracks lives inside each managed repo itself (git-ignored), so Hydra carries no project data of its own:

- `<repo>/.claude-hydra/` — task state, per-issue logs, goal, planning memory, planning passes
- `<repo>/.worktrees/` — one worktree per issue
- `<repo>/.claude/agents/` — the PE/PM planning agents (assigned in Settings → Agents) plus any subagents

## Prerequisites

- `gh` CLI authenticated against the managed repos (`gh auth status`)
- Anthropic auth for the Agent SDK: `ANTHROPIC_API_KEY` exported, or an existing Claude Code login
- Node + pnpm

## Quickstart

```bash
pnpm install
pnpm dev        # dashboard on http://localhost:3002
```

Make sure each managed repo git-ignores `.claude-hydra/` and `.worktrees/`.

## The board

Hydra polls GitHub every 2 minutes (or on "Poll now") to keep the board current with **all open issues** — filter by label or search by number, title, or assignee. Task status is mirrored back to GitHub through labels:

```
(Start button)  →  agent-working  →  agent-committed  →  agent-pr
                        │       ↘                (developer pushes)
                        │        agent-failed
                        ↓
                 agent-needs-input  (session paused on a question)
```

- **Nothing starts automatically** unless you enable auto-pickup — an agent session begins only when you press **Start agent** on a card.
- Each claimed issue is worked in its own git worktree on branch `agent/issue-{n}`, fully isolated from your checkout and from other agents. There is no cap on concurrent sessions.
- A clean finish lands as **committed**: the work sits in the worktree until you review it and press **Push & open PR**, which pushes the branch and opens the PR. (If the managed repo's own rules allow the agent to open a PR itself, the task moves to `agent-pr` directly.) Failures get `agent-failed` plus a short comment with the reason — retry from the dashboard.
- If the agent hits a genuine question, the session pauses as **needs input** — reply from the issue detail page and it resumes with full context.
- When a PR conflicts with the default branch, Hydra can start a conflict-resolution session that rebases the branch while preserving both sides' intent.

## Planning

Planning decides **what** to build; execution implements it. The two never touch — they meet only through GitHub issues.

- **Goal** (the Goal page): the project goal and current priorities steer every planning pass. Planning memory collects durable lessons (dismissal reasons, shaping feedback) so passes get smarter over time. Execution sessions don't see either — the issue itself is their spec.
- **Planning passes** (the Planning page): the assigned PE and PM agents scan the repo read-only in parallel, and their reports are synthesized into a deduped, ranked proposal list. **Only what you approve** gets filed as a GitHub issue (label: `proposed`); dismissed and already-filed proposals are excluded from future passes. Run on demand or on a schedule.
- **Ad-hoc planning**: shape a direction conversationally in the chat drawer, then launch a pass scoped to it. Regular passes are never affected by the chat.
- **Proposal discussion**: open the "Discuss" drawer on any proposal to refine, edit, or split it before filing. Filing always stays a human click.
- **Product map** (optional): assign a product-brief agent and Hydra generates `docs/product-map.md` in the repo. Planning reads it instead of re-scanning the code, and implementation sessions keep it up to date.

Every prompt Hydra sends to an LLM — implementation, conflict resolution, planning, synthesis, discussion — is an editable template (Settings → Prompts), customizable per repo.

## Policy lives in the repo, not in Hydra

Hydra manages sessions — worktrees, start/stop/resume, status, logs, the push button. It enforces **no rules of its own** about what agents may do. Each managed repo governs its agents through its own files, which every session loads:

- `CLAUDE.md` — conventions, architecture rules, workflow requirements
- `.claude/settings.json` — permission rules, enforced by the Claude Code runtime itself (e.g. deny `git push` to force the dashboard-push flow)
- `.claude/skills/` and `.claude/agents/` — codified procedures and subagents, listed in every session prompt

A repo with no rules imposes none: its agents can push, open PRs, and fetch freely. Add rules to the repo — not to Hydra — to restrict that. Your user-level `~/.claude` settings are never loaded, so sessions behave the same on any machine.

What remains true regardless of repo policy:

- Planning sessions are strictly read-only and never file issues themselves — filing is always your click.
- The server binds to localhost only, and state-mutating API routes reject non-local origins.

For a deeper look at how Hydra is structured, see the in-app **Help** page.
