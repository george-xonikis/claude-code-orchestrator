import type { Task, TaskStatus } from '@/lib/types';

/**
 * Pure Task helpers shared by the dashboard and the server (API routes, loop).
 * Lives in lib — like queue-order.ts — so server code never imports from
 * components/.
 */

/** Statuses with a live session (a paused question keeps its session alive). */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['working', 'needs_input'];

/** Tasks labeled "Non agent" must never be implemented by an agent. */
export function isNonAgentTask(task: Task): boolean {
  return (task.labels ?? []).some((label) => /^non[- ]?agent$/i.test(label));
}

export function countActiveSessions(tasks: Task[]): number {
  return tasks.filter((task) => ACTIVE_STATUSES.includes(task.status)).length;
}
