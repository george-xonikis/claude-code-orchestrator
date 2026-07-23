'use client';

import { useSyncExternalStore } from 'react';

import type { Task } from '@/lib/types';

export interface TasksSnapshot {
  /** Latest full Task[] snapshot from GET /api/tasks + GET /api/events. */
  tasks: Task[];
  /** True while the /api/events SSE stream is open. */
  connected: boolean;
}

const EMPTY_SNAPSHOT: TasksSnapshot = { tasks: [], connected: false };

/**
 * Module-level store shared by every useTasks() consumer (TopBar, board,
 * detail page) so the whole app holds exactly one /api/events EventSource.
 */
let snapshot: TasksSnapshot = EMPTY_SNAPSHOT;
let streamStarted = false;
let sseDelivered = false;
const listeners = new Set<() => void>();

function emit(next: Partial<TasksSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function ensureStream() {
  if (streamStarted || typeof window === 'undefined') return;
  streamStarted = true;

  // Initial fetch — only applied if the SSE stream hasn't delivered fresher data yet.
  fetch('/api/tasks')
    .then((res) => (res.ok ? (res.json() as Promise<Task[]>) : Promise.reject(new Error(`${res.status}`))))
    .then((tasks) => {
      if (!sseDelivered) emit({ tasks });
    })
    .catch(() => {
      // API not up yet — the SSE stream will populate once it connects.
    });

  const source = new EventSource('/api/events');
  source.onopen = () => emit({ connected: true });
  source.onmessage = (event) => {
    try {
      const tasks = JSON.parse(event.data) as Task[];
      sseDelivered = true;
      emit({ tasks, connected: true });
    } catch {
      // Malformed frame — ignore, keep the last good snapshot.
    }
  };
  // EventSource reconnects automatically; just reflect the drop in the UI.
  source.onerror = () => emit({ connected: false });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureStream();
  return () => {
    listeners.delete(listener);
  };
}

/** Live Task[] via GET /api/events (SSE), seeded by GET /api/tasks. */
export function useTasks(): TasksSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY_SNAPSHOT,
  );
}
