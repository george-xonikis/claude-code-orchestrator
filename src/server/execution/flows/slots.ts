/**
 * Live-session slots: one set of issue numbers per repo, held from claim until
 * the session reaches a terminal status. Shared by the loop (concurrency cap,
 * poll skips) and the flows (start paths reserve, failure paths release).
 * globalThis-guarded so Next dev hot-reload doesn't lose live slots.
 */

const globalRef = globalThis as typeof globalThis & {
  __hydraSlots?: Map<string, Set<number>>;
};

function slotSet(repoId: string): Set<number> {
  globalRef.__hydraSlots ??= new Map();
  let s = globalRef.__hydraSlots.get(repoId);
  if (!s) {
    s = new Set();
    globalRef.__hydraSlots.set(repoId, s);
  }
  return s;
}

/** Reserve an issue's slot (synchronous, so concurrency caps hold across awaits). */
export function reserveSlot(repoId: string, issueNumber: number): void {
  slotSet(repoId).add(issueNumber);
}

export function releaseSlot(repoId: string, issueNumber: number): void {
  slotSet(repoId).delete(issueNumber);
}

export function hasSlot(repoId: string, issueNumber: number): boolean {
  return slotSet(repoId).has(issueNumber);
}

export function activeCount(repoId: string): number {
  return slotSet(repoId).size;
}
