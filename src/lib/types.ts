/**
 * Shared contracts for the Agent Orchestrator.
 *
 * These types are the boundary between the server modules (src/server/*),
 * the REST/SSE API (src/app/api/*), and the dashboard UI — implement against
 * them exactly.
 */

/** One managed local git repo, from the registry at data/repos.json. */
export interface RepoInfo {
  /** Filesystem-safe slug of the basename + short hash of the absolute path. */
  id: string;
  /** Directory basename, for display. */
  name: string;
  /** Absolute path of the local checkout. */
  path: string;
  /** Whether <repo>/.claude/agents/ contains both planning persona files (computed at read time). */
  hasPersonas?: boolean;
  /** Which individual planning persona files exist (computed at read time). */
  personas?: { engineer: boolean; pm: boolean };
  /** GitHub web URL derived from the `origin` remote (computed at read time; absent if unparsable). */
  htmlUrl?: string;
}

/** One invocable subagent discovered under a repo's .claude/agents/ (frontmatter `name` == Task subagent_type). */
export interface AgentMeta {
  /** Frontmatter `name` — the string passed as `subagent_type` to the Task tool. */
  name: string;
  /** Frontmatter `description` (may be empty). */
  description: string;
  /** The .md filename (for display / debugging). */
  file: string;
}

export type TaskStatus = 'ready' | 'working' | 'needs_input' | 'committed' | 'pr_open' | 'failed';

export interface Task {
  issueNumber: number;
  title: string;
  status: TaskStatus;
  /** GitHub issue labels (includes agent-* plumbing labels; UI filters those out). */
  labels?: string[];
  /** GitHub assignee logins. */
  assignees?: string[];
  /** Model id the agent session runs on (e.g. claude-fable-5), from the SDK init message. */
  model?: string;
  /** Developer-chosen model for the NEXT session (ticket settings modal). */
  preferredModel?: string;
  /** Include dynamic-workflow orchestration guidance in the prompt (default true). */
  useWorkflow?: boolean;
  /** The task instructions the agent session was launched with. */
  prompt?: string;
  worktreePath?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  question?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
  turns?: number;
  costUsd?: number;
  logTail?: string[];
}

/** One task proposal produced by a planning pass (engineer + PM agents → synthesis). */
/** One turn in a proposal's "Discuss with Claude Code" transcript. */
export interface DiscussionMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface PlanningProposal {
  id: string;
  title: string;
  /** Markdown issue body (problem, proposed direction, success criteria). */
  body: string;
  /** GitHub labels from: Bug, FE, BE, AI, Infra. */
  labels: string[];
  source: 'engineer' | 'pm' | 'both';
  /** Effort/impact grades, 1 (low) – 5 (high). Legacy passes may hold S/M/L or high/medium. */
  effort?: string;
  impact?: string;
  status: 'pending' | 'filed' | 'dismissed';
  issueNumber?: number;
  issueUrl?: string;
  /** Persisted discussion transcript, so it survives refresh/navigation. */
  discussion?: DiscussionMessage[];
}

/** One captured line of a planning pass's live agent activity. */
export interface PlanningLogLine {
  role: 'engineer' | 'pm' | 'synthesis';
  kind: 'text' | 'tool';
  text: string;
}

/** One planning-pass run, newest first in .orchestrator/planning.json. */
export interface PlanningPass {
  id: string;
  startedAt: string;
  status: 'running' | 'complete' | 'failed';
  error?: string;
  proposals: PlanningProposal[];
  /** Which agents this pass ran (absent on legacy passes → assume both). */
  roles?: ('engineer' | 'pm')[];
  /** Streamed engineer/PM/synthesis activity, kept so the pass log stays viewable when done. */
  logs?: PlanningLogLine[];
}

/** One live agent session on the overview page (status working or needs_input). */
export interface OverviewSession {
  issueNumber: number;
  title: string;
  status: Extract<TaskStatus, 'working' | 'needs_input'>;
  model?: string;
  startedAt?: string;
}

/** One repo's roll-up on GET /api/overview — everything a fleet card renders. */
export interface RepoOverview {
  repo: RepoInfo;
  /** Task count per board column (statuses with zero tasks are present as 0). */
  counts: Record<TaskStatus, number>;
  /** Live sessions, working first, then needs_input. */
  sessions: OverviewSession[];
  /** Ready, agent-eligible tickets auto-pickup would drain. */
  queueCount: number;
  autoStart: boolean;
  maxActive: number;
  planningRunning: boolean;
  /** Newest Task.updatedAt across the repo's tasks (absent when no tasks). */
  lastActivityAt?: string;
}

/** One line in .orchestrator/logs/issue-{n}.jsonl and on the /api/tasks/[n]/logs SSE stream. */
export interface LogEvent {
  ts: string;
  kind: 'prompt' | 'tool' | 'edit' | 'test' | 'commit' | 'question' | 'info' | 'error' | 'result';
  text: string;
}
