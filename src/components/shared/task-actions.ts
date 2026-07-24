import type { DiscussionMessage, PlanningPass, Task, TaskStatus } from '@/lib/types';

// Re-exported so existing importers keep resolving it from this module.
export type { DiscussionMessage };

/** Statuses with a live session (a paused question keeps its session alive). */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['working', 'needs_input'];

/** Tasks labeled "Non agent" must never be implemented by an agent. */
export function isNonAgentTask(task: Task): boolean {
  return (task.labels ?? []).some((label) => /^non[- ]?agent$/i.test(label));
}

export function countActiveSessions(tasks: Task[]): number {
  return tasks.filter((task) => ACTIVE_STATUSES.includes(task.status)).length;
}

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
  memory: string;
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

/** null = manual only; otherwise auto-run every N hours. */
export function setPlanningInterval(repoId: string, hours: number | null): Promise<void> {
  return post(`/api/planning/interval${repoQuery(repoId)}`, { hours });
}

export interface AutonomyConfig {
  /** Master switch: scheduled passes auto-file proposals and the loop auto-starts sessions. */
  autonomous: boolean;
  /** Max concurrent agent sessions the loop may auto-start. */
  maxActive: number;
  /** Max top-ranked proposals a scheduled pass auto-files per run. */
  maxAutoFile: number;
}

export async function getAutonomy(repoId: string): Promise<AutonomyConfig> {
  const res = await fetch(`/api/planning/autonomy${repoQuery(repoId)}`);
  if (!res.ok) throw new Error(`GET /api/planning/autonomy failed with ${res.status}`);
  return (await res.json()) as AutonomyConfig;
}

export function setAutonomy(repoId: string, patch: Partial<AutonomyConfig>): Promise<void> {
  return post(`/api/planning/autonomy${repoQuery(repoId)}`, patch);
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
): Promise<void> {
  return post(`/api/planning/dismiss${repoQuery(repoId)}`, { passId, proposalIds });
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
