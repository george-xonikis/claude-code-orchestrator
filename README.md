# Claude Code Orchestrator

Local dashboard that runs autonomous Claude Code agents against a repo's GitHub issues: a kanban of every open issue, one-click agent sessions in isolated git worktrees, planning agents that propose new tasks toward your goal, and a review-then-push gate so nothing reaches GitHub without you. Standalone Next.js app — runs on your machine, never deployed.

Works with any local git repository that has a GitHub remote. Per-repo runtime state lives inside the managed repo itself, so the orchestrator carries no project data of its own:

- `<repo>/.orchestrator/` — task state, per-issue logs, goal, memory, planning passes (git-ignored)
- `<repo>/.worktrees/` — one worktree per issue (git-ignored)
- `<repo>/.claude/agents/principal-engineer.md` + `product-manager.md` — the planning personas (used by the Planning page)

> Pointing the orchestrator at a repo is currently done via the `REPO_ROOT` constants in `src/server/*`. UI-based repo management (open/switch multiple repos, IDE-style) is the next step.

## Prerequisites

- `gh` CLI authenticated against the managed repo (`gh auth status`)
- Anthropic auth for the Agent SDK: `ANTHROPIC_API_KEY` exported, or an existing Claude Code login
- Node + pnpm

## Quickstart

```bash
pnpm install
pnpm dev        # dashboard on http://localhost:3002
```

Make sure the managed repo git-ignores `.orchestrator/` and `.worktrees/`.

## How it works

The orchestrator polls GitHub every 2 minutes (or on "Poll now") to keep the board current with **all open issues**, and mirrors task status through a label loop:

```
(Start button)  →  agent-working  →  agent-committed  →  agent-pr
                        │       ↘                (developer pushes)
                        │        agent-failed
                        ↓
                 agent-needs-input  (session paused on a question)
```

- **Nothing starts automatically.** Every open issue appears on the board (filter by its GitHub labels or search by number, title, or assignee); an agent session begins only when you press **Start agent** on a card.
- A claimed issue gets a git worktree at `.worktrees/issue-{n}` on branch `agent/issue-{n}`, and an agent session starts (fire-and-forget via the Claude Agent SDK).
- Agents NEVER push or open PRs (blocked by prompt AND a command deny-list). A clean finish lands as **committed** (`agent-committed`): the work sits in the worktree until you review it and press **Push & open PR** on the dashboard, which pushes the branch and opens the PR (**`agent-pr`**). Failures get **`agent-failed`** plus a short comment with the reason (retry from the dashboard).
- If the agent asks a question, the session pauses as **needs_input** — reply from the issue detail page and the session resumes with its full context. The session stays alive while waiting.

There is no cap on concurrent agent sessions — start as many as you want.

**Goal & memory** (the Goal page): `.orchestrator/goal.md` (project goal and current priorities) and `.orchestrator/memory.md` (reusable lessons) are injected into every session's task prompt. Agents append lessons via their `save_memory` tool, stamped with the issue number; curate both from the page (markdown, preview by default).

**Planning** (the Planning page): runs the principal-engineer and product-manager personas in parallel as read-only sessions, synthesizes their reports into a deduped proposal list, and files ONLY what you approve as GitHub issues (label: `proposed`). Previously dismissed/pending/filed proposals are fed back as exclusions so passes don't repeat themselves. Run on demand or on an interval (while the app is running).

## Guardrails

- Agent file access is confined to the issue's worktree; credential paths and out-of-worktree `.env*` files are denied.
- `git push`, `gh pr create`, deploy/prod command patterns, and non-GitHub network fetches are denied inside sessions — pushing and PR creation happen only from the dashboard, by you.
- Agents run lint and unit tests only; e2e tests and database migrations are never run.
- Planning sessions are strictly read-only and cannot create issues themselves.
- The server binds to localhost only, and state-mutating API routes reject non-local origins.
