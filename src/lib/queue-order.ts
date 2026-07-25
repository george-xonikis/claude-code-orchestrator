import type { Task } from '@/lib/types';

/**
 * Auto-pickup queue ordering — the SINGLE source of truth shared by the loop
 * (which actually drains the queue) and the board/queue UI (which shows it), so
 * what you see is the order agents run in.
 *
 * `manualOrder` is a list of issue numbers the developer arranged by hand in the
 * queue modal. Tickets named there come first, in that exact order; everything
 * else follows in the configured default order (oldest/newest by issue number),
 * so newly synced issues append predictably instead of disappearing into a gap.
 */

/** Max issue numbers a manual order may pin (keeps the config file bounded). */
export const MAX_MANUAL_QUEUE = 200;

/** Order queue-eligible tasks: manually pinned first, then the default sort. */
export function orderQueue<T extends Pick<Task, 'issueNumber'>>(
  tasks: T[],
  queueOrder: 'oldest' | 'newest',
  manualOrder: number[] = []
): T[] {
  // Issue numbers are monotonic, so ascending = oldest first.
  const byDefault = (a: T, b: T) =>
    queueOrder === 'newest' ? b.issueNumber - a.issueNumber : a.issueNumber - b.issueNumber;

  if (manualOrder.length === 0) return [...tasks].sort(byDefault);

  const rank = new Map(manualOrder.map((issueNumber, index) => [issueNumber, index]));
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const task of tasks) {
    (rank.has(task.issueNumber) ? pinned : rest).push(task);
  }
  pinned.sort((a, b) => (rank.get(a.issueNumber) ?? 0) - (rank.get(b.issueNumber) ?? 0));
  rest.sort(byDefault);
  return [...pinned, ...rest];
}

/** Keep only positive integers, de-duplicated and capped. */
export function sanitizeManualQueue(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_MANUAL_QUEUE) break;
  }
  return out;
}
