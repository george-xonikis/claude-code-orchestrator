'use client';

import { useSyncExternalStore } from 'react';

import type { RepoOverview } from '@/lib/types';

export interface OverviewSnapshot {
  /** Latest GET /api/overview payload (all repos). */
  repos: RepoOverview[];
  /** True once the first fetch has resolved (success or failure). */
  loaded: boolean;
}

const EMPTY_SNAPSHOT: OverviewSnapshot = { repos: [], loaded: false };

/**
 * Module-level polling singleton (same pattern as use-tasks): however many
 * components call useOverview() — the fleet page and the top bar chip — the app
 * runs exactly one 10s poll while at least one is mounted.
 */
let snapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

const POLL_MS = 10_000;

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/api/overview');
    if (!res.ok) throw new Error(`${res.status}`);
    snapshot = { repos: (await res.json()) as RepoOverview[], loaded: true };
  } catch {
    snapshot = { ...snapshot, loaded: true }; // keep the last good data
  }
  listeners.forEach((listener) => listener());
}

/** Re-fetch now (e.g. right after registering a repo) without waiting for the poll. */
export function refreshOverview(): void {
  if (listeners.size > 0) void refresh();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refresh();
    timer = setInterval(refresh, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** All repos' roll-ups from GET /api/overview, polled while subscribed. */
export function useOverview(): OverviewSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY_SNAPSHOT);
}
