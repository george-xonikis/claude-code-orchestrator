'use client';

import { useCallback, useSyncExternalStore } from 'react';

import type { Task } from '@/lib/types';
import { useRepo } from '@/components/shared/use-repo';

export interface TasksSnapshot {
  /** Latest full Task[] snapshot from GET /api/tasks + GET /api/events. */
  tasks: Task[];
  /** True while the /api/events SSE stream is open. */
  connected: boolean;
}

const EMPTY_SNAPSHOT: TasksSnapshot = { tasks: [], connected: false };

interface RepoStream {
  snapshot: TasksSnapshot;
  source: EventSource;
  sseDelivered: boolean;
  listeners: Set<() => void>;
}

/**
 * One stream per repo id, shared by every useTasks() consumer (TopBar, board,
 * detail page) so the app holds exactly one /api/events EventSource for the
 * selected repo. When the last consumer unsubscribes (e.g. the selection
 * changes), the stream closes and its cache is dropped.
 */
const streams = new Map<string, RepoStream>();

function emit(stream: RepoStream, next: Partial<TasksSnapshot>) {
  stream.snapshot = { ...stream.snapshot, ...next };
  stream.listeners.forEach((listener) => listener());
}

function openStream(repoId: string): RepoStream {
  const query = `?repo=${encodeURIComponent(repoId)}`;
  const source = new EventSource(`/api/events${query}`);
  const stream: RepoStream = {
    snapshot: EMPTY_SNAPSHOT,
    source,
    sseDelivered: false,
    listeners: new Set(),
  };

  // Initial fetch — only applied if the SSE stream hasn't delivered fresher data yet.
  fetch(`/api/tasks${query}`)
    .then((res) => (res.ok ? (res.json() as Promise<Task[]>) : Promise.reject(new Error(`${res.status}`))))
    .then((tasks) => {
      if (!stream.sseDelivered) emit(stream, { tasks });
    })
    .catch(() => {
      // API not up yet — the SSE stream will populate once it connects.
    });

  source.onopen = () => emit(stream, { connected: true });
  source.onmessage = (event) => {
    try {
      const tasks = JSON.parse(event.data) as Task[];
      stream.sseDelivered = true;
      emit(stream, { tasks, connected: true });
    } catch {
      // Malformed frame — ignore, keep the last good snapshot.
    }
  };
  // EventSource reconnects automatically; just reflect the drop in the UI.
  source.onerror = () => emit(stream, { connected: false });

  return stream;
}

function subscribeRepo(repoId: string, listener: () => void): () => void {
  let stream = streams.get(repoId);
  if (!stream) {
    stream = openStream(repoId);
    streams.set(repoId, stream);
  }
  stream.listeners.add(listener);
  return () => {
    stream.listeners.delete(listener);
    if (stream.listeners.size === 0) {
      stream.source.close();
      streams.delete(repoId);
    }
  };
}

/** Live Task[] for the selected repo via GET /api/events (SSE), seeded by GET /api/tasks. */
export function useTasks(): TasksSnapshot {
  const { current } = useRepo();
  const repoId = current?.id ?? null;

  const subscribe = useCallback(
    (listener: () => void) => (repoId ? subscribeRepo(repoId, listener) : () => {}),
    [repoId],
  );
  const getSnapshot = useCallback(
    () => (repoId ? (streams.get(repoId)?.snapshot ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT),
    [repoId],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);
}
