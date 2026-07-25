import type { AgentMeta, DiscussionMessage, PlanningPass, Task, TaskStatus } from '@/lib/types';
import { ACTIVE_STATUSES } from '@/lib/task-helpers';

// Re-exported so existing importers keep resolving these from this module.
export type { DiscussionMessage };
export { ACTIVE_STATUSES, countActiveSessions, isNonAgentTask } from '@/lib/task-helpers';

/** Every API call is scoped to a registered repo via the `?repo=<id>` query param. */
function repoQuery(repoId: string): string {
  return `?repo=${encodeURIComponent(repoId)}`;
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `POST ${path} failed with ${res.status}`);
  }
}

export function pollNow(repoId: string): Promise<void> {
  return post(`/api/poll${repoQuery(repoId)}`);
}

export function startTask(repoId: string, issueNumber: number, model?: string): Promise<void> {
  return post(
    `/api/tasks/${issueNumber}/start${repoQuery(repoId)}`,
    model ? { model } : undefined
  );
}

export function stopTask(repoId: string, issueNumber: number): Promise<void> {
  return post(`/api/tasks/${issueNumber}/stop${repoQuery(repoId)}`);
}

export function retryTask(repoId: string, issueNumber: number): Promise<void> {
  return post(`/api/tasks/${issueNumber}/retry${repoQuery(repoId)}`);
}

/** Push the committed branch and open its PR — the only path that publishes to GitHub. */
export function pushTask(repoId: string, issueNumber: number): Promise<void> {
  return post(`/api/tasks/${issueNumber}/push${repoQuery(repoId)}`);
}

export type ManualStatus = Extract<TaskStatus, 'ready' | 'committed' | 'failed'>;

export const MANUAL_STATUSES: readonly ManualStatus[] = ['ready', 'committed', 'failed'];

/** Manually override a task's status (e.g. failed -> committed). */
export function setTaskStatus(
  repoId: string,
  issueNumber: number,
  status: ManualStatus,
): Promise<void> {
  return post(`/api/tasks/${issueNumber}/status${repoQuery(repoId)}`, { status });
}

export interface OrchestratorSettings {
  goal: string;
  /** Execution memory: codebase gotchas agents hit while implementing. */
  memory: string;
  /** Planning memory: prioritization guidance the PE/PM personas read. */
  planningMemory: string;
}

export async function getSettings(repoId: string): Promise<OrchestratorSettings> {
  const res = await fetch(`/api/settings${repoQuery(repoId)}`);
  if (!res.ok) throw new Error(`GET /api/settings failed with ${res.status}`);
  return (await res.json()) as OrchestratorSettings;
}

export function saveSettings(repoId: string, patch: Partial<OrchestratorSettings>): Promise<void> {
  return post(`/api/settings${repoQuery(repoId)}`, patch);
}

export interface PlanningData {
  passes: PlanningPass[];
  intervalHours: number | null;
}

export async function getPlanning(repoId: string): Promise<PlanningData> {
  const res = await fetch(`/api/planning${repoQuery(repoId)}`);
  if (!res.ok) throw new Error(`GET /api/planning failed with ${res.status}`);
  return (await res.json()) as PlanningData;
}

export type PlanningRole = 'engineer' | 'pm';

/** Run a planning pass. Omit roles for the full PE + PM pass, or pass a single role. */
export function startPlanningPass(repoId: string, roles?: PlanningRole[]): Promise<void> {
  return post(`/api/planning/start${repoQuery(repoId)}`, roles ? { roles } : undefined);
}

/** Abort the in-flight planning pass for a repo. */
export function cancelPlanningPass(repoId: string): Promise<void> {
  return post(`/api/planning/cancel${repoQuery(repoId)}`);
}

/**
 * Pass-level steering chat: shapes what the NEXT pass looks for. Chat turns are
 * cheap (no repo scan) and never produce proposals — regenerate a pass for that.
 */
export async function getPlanningSteering(repoId: string): Promise<DiscussionMessage[]> {
  const res = await fetch(`/api/planning/steering${repoQuery(repoId)}`);
  if (!res.ok) throw new Error(`GET /api/planning/steering failed with ${res.status}`);
  return ((await res.json()) as { messages: DiscussionMessage[] }).messages;
}

/** Send one steering turn; resolves with the full updated transcript. */
export async function sendPlanningSteering(
  repoId: string,
  text: string
): Promise<DiscussionMessage[]> {
  const res = await fetch(`/api/planning/steering${repoQuery(repoId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `steering turn failed with ${res.status}`);
  }
  return ((await res.json()) as { messages: DiscussionMessage[] }).messages;
}

/** Clear the steering transcript so the next pass runs unsteered. */
export async function clearPlanningSteering(repoId: string): Promise<void> {
  const res = await fetch(`/api/planning/steering${repoQuery(repoId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`clear steering failed with ${res.status}`);
}

/** Max focus topics a plan may be steered toward (mirrors the server constant). */
export const MAX_PLANNING_TOPICS = 3;

export interface PlanningConfig {
  /** Auto-run every N hours; null = manual only. */
  intervalHours: number | null;
  /** Which agents scheduled/auto passes run. */
  roles: PlanningRole[];
  /** Auto-file a scheduled pass's top proposals as issues. */
  autoFile: boolean;
  /** Max top-ranked proposals a scheduled pass auto-files per run. */
  maxAutoFile: number;
  /** Max proposals a pass produces. */
  maxProposals: number;
  /** Only surface proposals with impact >= this (1-5). */
  minImpact: number;
  /** Only surface proposals with effort <= this (1-5). */
  maxEffort: number;
  /** Free-text focus topics steering the plan (<= MAX_PLANNING_TOPICS). */
  topics: string[];
  /** Agent (`.claude/agents/` name) filling the PE role; null = default persona. */
  peAgent: string | null;
  /** Agent filling the PM role; null = default persona. */
  pmAgent: string | null;
  /** Agent that maintains the repo's product brief; null = none. */
  briefAgent: string | null;
}

/** Per-repo execution config — the auto-pickup loop + the pre-commit review gate. */
export interface ExecutionConfig {
  /** Auto-start agent sessions for ready proposed issues, up to maxActive. */
  autoStart: boolean;
  /** Order the pickup queue drains: oldest issue first, or newest first. */
  queueOrder: 'oldest' | 'newest';
  /** Max concurrent agent sessions the loop may auto-start. */
  maxActive: number;
  /** Max tasks auto-pickup executes per run before stopping; null = unlimited. */
  tasksPerRun: number | null;
  /** How often the loop polls GitHub for this repo's issues, in minutes; null = off. */
  pollMinutes: number | null;
  /** Reviewer subagent `name`s an execution agent MUST run before it may commit; empty = no gate. */
  reviewerAgents: string[];
  /** Model agent sessions run on; a ticket's own preferredModel overrides it. */
  executionModel: string;
  /** Issue numbers arranged by hand in the queue; they drain first, in this order. */
  manualQueue: number[];
}

export async function getPlanningConfig(repoId: string): Promise<PlanningConfig> {
  const res = await fetch(`/api/planning/config${repoQuery(repoId)}`);
  if (!res.ok) throw new Error(`GET /api/planning/config failed with ${res.status}`);
  return (await res.json()) as PlanningConfig;
}

export async function getExecutionConfig(repoId: string): Promise<ExecutionConfig> {
  const res = await fetch(`/api/execution/config${repoQuery(repoId)}`);
  if (!res.ok) throw new Error(`GET /api/execution/config failed with ${res.status}`);
  return (await res.json()) as ExecutionConfig;
}

/** Patch execution config; the server validates/clamps and returns the saved config. */
export async function setExecutionConfig(
  repoId: string,
  patch: Partial<ExecutionConfig>
): Promise<ExecutionConfig> {
  const res = await fetch(`/api/execution/config${repoQuery(repoId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `POST /api/execution/config failed with ${res.status}`);
  }
  return (await res.json()) as ExecutionConfig;
}

/** The repo's invocable subagents (from .claude/agents/), for the reviewer picker. */
export async function getRepoAgents(repoId: string): Promise<AgentMeta[]> {
  const res = await fetch(`/api/agents${repoQuery(repoId)}`);
  if (!res.ok) throw new Error(`GET /api/agents failed with ${res.status}`);
  return (await res.json()) as AgentMeta[];
}

/** Patch the config; the server validates/clamps and returns the saved config. */
export async function setPlanningConfig(
  repoId: string,
  patch: Partial<PlanningConfig>
): Promise<PlanningConfig> {
  const res = await fetch(`/api/planning/config${repoQuery(repoId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `POST /api/planning/config failed with ${res.status}`);
  }
  return (await res.json()) as PlanningConfig;
}

export interface TicketSettings {
  title: string;
  body: string;
  preferredModel?: string;
  useWorkflow?: boolean;
}

export async function getTicketSettings(
  repoId: string,
  issueNumber: number
): Promise<TicketSettings> {
  const res = await fetch(`/api/tasks/${issueNumber}/settings${repoQuery(repoId)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `GET ticket settings failed with ${res.status}`);
  }
  return (await res.json()) as TicketSettings;
}

export function saveTicketSettings(
  repoId: string,
  issueNumber: number,
  patch: Partial<TicketSettings>
): Promise<void> {
  return post(`/api/tasks/${issueNumber}/settings${repoQuery(repoId)}`, patch);
}

/** One discussion turn about a proposal; the transcript is persisted server-side. */
export async function discussProposal(
  repoId: string,
  passId: string,
  proposalId: string,
  messages: DiscussionMessage[]
): Promise<string> {
  const res = await fetch(`/api/planning/discuss${repoQuery(repoId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passId, proposalId, messages }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `discussion failed with ${res.status}`);
  }
  return ((await res.json()) as { reply: string }).reply;
}

/** Clear a proposal's persisted discussion transcript. */
export async function clearProposalDiscussion(
  repoId: string,
  passId: string,
  proposalId: string
): Promise<void> {
  const res = await fetch(`/api/planning/discuss${repoQuery(repoId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passId, proposalId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `clear failed with ${res.status}`);
  }
}

export function filePlanningProposals(
  repoId: string,
  passId: string,
  proposalIds: string[],
): Promise<void> {
  return post(`/api/planning/file${repoQuery(repoId)}`, { passId, proposalIds });
}

export function dismissPlanningProposals(
  repoId: string,
  passId: string,
  proposalIds: string[],
  reason?: string,
): Promise<void> {
  return post(`/api/planning/dismiss${repoQuery(repoId)}`, { passId, proposalIds, reason });
}

export function replyTask(repoId: string, issueNumber: number, message: string): Promise<void> {
  return post(`/api/tasks/${issueNumber}/reply${repoQuery(repoId)}`, { message });
}

/** Stops every session currently holding a slot (working + needs_input). */
export async function stopAllTasks(repoId: string, tasks: Task[]): Promise<void> {
  await Promise.allSettled(
    tasks
      .filter((task) => ACTIVE_STATUSES.includes(task.status))
      .map((task) => stopTask(repoId, task.issueNumber)),
  );
}
