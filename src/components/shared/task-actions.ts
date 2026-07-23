import type { PlanningPass, Task, TaskStatus } from '@/lib/types';

/** Statuses with a live session (a paused question keeps its session alive). */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['working', 'needs_input'];

export function countActiveSessions(tasks: Task[]): number {
  return tasks.filter((task) => ACTIVE_STATUSES.includes(task.status)).length;
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  if (!res.ok) throw new Error(`POST ${path} failed with ${res.status}`);
}

export function pollNow(): Promise<void> {
  return post('/api/poll');
}


export function startTask(issueNumber: number): Promise<void> {
  return post(`/api/tasks/${issueNumber}/start`);
}

export function stopTask(issueNumber: number): Promise<void> {
  return post(`/api/tasks/${issueNumber}/stop`);
}

export function retryTask(issueNumber: number): Promise<void> {
  return post(`/api/tasks/${issueNumber}/retry`);
}

/** Push the committed branch and open its PR — the only path that publishes to GitHub. */
export function pushTask(issueNumber: number): Promise<void> {
  return post(`/api/tasks/${issueNumber}/push`);
}

export type ManualStatus = Extract<TaskStatus, 'ready' | 'committed' | 'failed'>;

export const MANUAL_STATUSES: readonly ManualStatus[] = ['ready', 'committed', 'failed'];

/** Manually override a task's status (e.g. failed -> committed). */
export function setTaskStatus(issueNumber: number, status: ManualStatus): Promise<void> {
  return post(`/api/tasks/${issueNumber}/status`, { status });
}

export interface OrchestratorSettings {
  goal: string;
  memory: string;
}

export async function getSettings(): Promise<OrchestratorSettings> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error(`GET /api/settings failed with ${res.status}`);
  return (await res.json()) as OrchestratorSettings;
}

export function saveSettings(patch: Partial<OrchestratorSettings>): Promise<void> {
  return post('/api/settings', patch);
}

export interface PlanningData {
  passes: PlanningPass[];
  intervalHours: number | null;
}

export async function getPlanning(): Promise<PlanningData> {
  const res = await fetch('/api/planning');
  if (!res.ok) throw new Error(`GET /api/planning failed with ${res.status}`);
  return (await res.json()) as PlanningData;
}

export function startPlanningPass(): Promise<void> {
  return post('/api/planning/start');
}

/** null = manual only; otherwise auto-run every N hours. */
export function setPlanningInterval(hours: number | null): Promise<void> {
  return post('/api/planning/interval', { hours });
}

export function filePlanningProposals(passId: string, proposalIds: string[]): Promise<void> {
  return post('/api/planning/file', { passId, proposalIds });
}

export function dismissPlanningProposals(passId: string, proposalIds: string[]): Promise<void> {
  return post('/api/planning/dismiss', { passId, proposalIds });
}

export function replyTask(issueNumber: number, message: string): Promise<void> {
  return post(`/api/tasks/${issueNumber}/reply`, { message });
}

/** Stops every session currently holding a slot (working + needs_input). */
export async function stopAllTasks(tasks: Task[]): Promise<void> {
  await Promise.allSettled(
    tasks
      .filter((task) => ACTIVE_STATUSES.includes(task.status))
      .map((task) => stopTask(task.issueNumber)),
  );
}
