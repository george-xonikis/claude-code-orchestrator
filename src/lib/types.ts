/**
 * Shared contracts for the Agent Orchestrator.
 *
 * These types are the boundary between the server modules (src/server/*),
 * the REST/SSE API (src/app/api/*), and the dashboard UI — implement against
 * them exactly.
 */

export type TaskStatus = 'ready' | 'working' | 'needs_input' | 'committed' | 'pr_open' | 'failed';

export interface Task {
  issueNumber: number;
  title: string;
  status: TaskStatus;
  /** GitHub issue labels (includes agent-* plumbing labels; UI filters those out). */
  labels?: string[];
  /** GitHub assignee logins. */
  assignees?: string[];
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
export interface PlanningProposal {
  id: string;
  title: string;
  /** Markdown issue body (problem, proposed direction, success criteria). */
  body: string;
  /** GitHub labels from: Bug, FE, BE, AI, Infra. */
  labels: string[];
  source: 'engineer' | 'pm' | 'both';
  effort?: string;
  impact?: string;
  status: 'pending' | 'filed' | 'dismissed';
  issueNumber?: number;
  issueUrl?: string;
}

/** One planning-pass run, newest first in .orchestrator/planning.json. */
export interface PlanningPass {
  id: string;
  startedAt: string;
  status: 'running' | 'complete' | 'failed';
  error?: string;
  proposals: PlanningProposal[];
}

/** One line in .orchestrator/logs/issue-{n}.jsonl and on the /api/tasks/[n]/logs SSE stream. */
export interface LogEvent {
  ts: string;
  kind: 'prompt' | 'tool' | 'edit' | 'test' | 'commit' | 'question' | 'info' | 'error' | 'result';
  text: string;
}
