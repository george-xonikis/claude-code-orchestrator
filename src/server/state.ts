import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { LogEvent, Task } from '@/lib/types';

/**
 * Orchestrator state store.
 *
 * Persistent state lives in <repo-root>/.orchestrator/state.json; per-issue JSONL
 * logs in <repo-root>/.orchestrator/logs/issue-{n}.jsonl (both git-ignored).
 *
 * The in-memory store + subscriber sets are lazily initialized behind a
 * globalThis guard so Next dev hot-reload doesn't duplicate them.
 *
 * Persistence notes:
 * - state.json is written atomically (temp file + rename), writes serialized
 *   through a promise chain.
 * - Task.logTail is NOT persisted in state.json (the JSONL files are the source
 *   of truth); it is rebuilt from the log files during hydration and kept
 *   up-to-date in memory by appendLog().
 */

const REPO_ROOT = '/Users/george-xon/Downloads/Git/nous-ai';
const ORCH_DIR = path.join(REPO_ROOT, '.orchestrator');
const STATE_FILE = path.join(ORCH_DIR, 'state.json');
const LOGS_DIR = path.join(ORCH_DIR, 'logs');
const DEFAULT_TAIL_LINES = 200;

type TaskListener = (tasks: Task[]) => void;
type LogListener = (event: LogEvent) => void;

interface StateGlobal {
  tasks: Map<number, Task>;
  subscribers: Set<TaskListener>;
  logSubscribers: Map<number, Set<LogListener>>;
  hydration: Promise<void> | null;
  writeChain: Promise<void>;
}

const globalRef = globalThis as typeof globalThis & {
  __orchestratorState?: StateGlobal;
};

function store(): StateGlobal {
  if (!globalRef.__orchestratorState) {
    globalRef.__orchestratorState = {
      tasks: new Map(),
      subscribers: new Set(),
      logSubscribers: new Map(),
      hydration: null,
      writeChain: Promise.resolve(),
    };
  }
  return globalRef.__orchestratorState;
}

function logFile(issueNumber: number): string {
  return path.join(LOGS_DIR, `issue-${issueNumber}.jsonl`);
}

/** Render one LogEvent to a display line (used for Task.logTail). */
function renderLogLine(event: LogEvent): string {
  const time = event.ts.length >= 19 ? event.ts.slice(11, 19) : event.ts;
  return `${time} [${event.kind}] ${event.text}`;
}

// ---------------------------------------------------------------------------
// Hydration + persistence
// ---------------------------------------------------------------------------

async function hydrate(): Promise<void> {
  const s = store();
  let raw: string;
  try {
    raw = await fsp.readFile(STATE_FILE, 'utf8');
  } catch {
    return; // No state yet — first run.
  }
  try {
    const parsed = JSON.parse(raw) as { tasks?: Task[] };
    for (const task of parsed.tasks ?? []) {
      if (typeof task?.issueNumber !== 'number') continue;
      s.tasks.set(task.issueNumber, task);
    }
  } catch {
    return; // Corrupt state file — start fresh (logs on disk are untouched).
  }
  for (const task of s.tasks.values()) {
    task.logTail = await readLogTail(task.issueNumber);
  }
}

function ensureHydrated(): Promise<void> {
  const s = store();
  s.hydration ??= hydrate();
  return s.hydration;
}

/** Atomic, serialized write of state.json (logTail excluded). */
function persist(): void {
  const s = store();
  const tasks = [...s.tasks.values()]
    .sort((a, b) => a.issueNumber - b.issueNumber)
    .map((task) => {
      const copy: Task = { ...task };
      delete copy.logTail;
      return copy;
    });
  const payload = JSON.stringify({ tasks }, null, 2);
  s.writeChain = s.writeChain
    .then(async () => {
      await fsp.mkdir(ORCH_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, STATE_FILE);
    })
    .catch((err) => {
      console.error('[orchestrator] failed to persist state.json:', err);
    });
}

function snapshot(): Task[] {
  return [...store().tasks.values()]
    .sort((a, b) => a.issueNumber - b.issueNumber)
    .map((task) => ({
      ...task,
      logTail: task.logTail ? [...task.logTail] : undefined,
    }));
}

function notifySubscribers(): void {
  const tasks = snapshot();
  for (const listener of store().subscribers) {
    try {
      listener(tasks);
    } catch {
      // A broken SSE listener must not break state updates.
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Current snapshot of all tasks (loaded from state.json on first access). */
export async function getTasks(): Promise<Task[]> {
  await ensureHydrated();
  return snapshot();
}

/**
 * Create or patch a task by issueNumber, persist state.json, notify subscribers.
 * A key explicitly present with value `undefined` CLEARS that field (e.g.
 * `{ question: undefined }` on resume). Returns the merged task.
 */
export async function upsertTask(patch: Partial<Task> & { issueNumber: number }): Promise<Task> {
  await ensureHydrated();
  const s = store();
  let task = s.tasks.get(patch.issueNumber);
  if (!task) {
    task = { issueNumber: patch.issueNumber, title: '', status: 'ready' };
    s.tasks.set(patch.issueNumber, task);
  }
  const target = task as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'issueNumber') continue;
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
  task.updatedAt = new Date().toISOString();
  persist();
  notifySubscribers();
  return { ...task, logTail: task.logTail ? [...task.logTail] : undefined };
}

/** Remove a task (its issue is no longer discovered as ready), persist, notify. */
export async function removeTask(issueNumber: number): Promise<void> {
  await ensureHydrated();
  const s = store();
  if (!s.tasks.delete(issueNumber)) return;
  persist();
  notifySubscribers();
}

/**
 * Subscribe to full Task[] snapshots on any change (backs GET /api/events).
 * Returns an unsubscribe function.
 */
export function subscribe(listener: (tasks: Task[]) => void): () => void {
  const s = store();
  s.subscribers.add(listener);
  return () => {
    s.subscribers.delete(listener);
  };
}

/** Append one event to .orchestrator/logs/issue-{n}.jsonl and notify log streams. */
export async function appendLog(issueNumber: number, event: LogEvent): Promise<void> {
  await ensureHydrated();
  const s = store();

  await fsp.mkdir(LOGS_DIR, { recursive: true });
  await fsp.appendFile(logFile(issueNumber), `${JSON.stringify(event)}\n`, 'utf8');

  // Keep the in-memory logTail current (not persisted; rebuilt on hydrate).
  const task = s.tasks.get(issueNumber);
  if (task) {
    task.logTail = [...(task.logTail ?? []), renderLogLine(event)].slice(-DEFAULT_TAIL_LINES);
    notifySubscribers();
  }

  const listeners = s.logSubscribers.get(issueNumber);
  if (listeners) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A broken SSE listener must not break logging.
      }
    }
  }
}

/**
 * Subscribe to live LogEvents for one issue (backs GET /api/tasks/[n]/logs).
 * Returns an unsubscribe function.
 */
export function subscribeLogs(issueNumber: number, listener: LogListener): () => void {
  const s = store();
  let listeners = s.logSubscribers.get(issueNumber);
  if (!listeners) {
    listeners = new Set();
    s.logSubscribers.set(issueNumber, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      s.logSubscribers.delete(issueNumber);
    }
  };
}

/** Read the last `maxLines` raw LogEvents for an issue (SSE replay). */
export async function readLogEvents(
  issueNumber: number,
  maxLines = DEFAULT_TAIL_LINES
): Promise<LogEvent[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(logFile(issueNumber), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const events: LogEvent[] = [];
  for (const line of lines.slice(-maxLines)) {
    try {
      const event = JSON.parse(line) as LogEvent;
      if (event && typeof event.text === 'string') events.push(event);
    } catch {
      // Skip malformed lines.
    }
  }
  return events;
}

/** Read the last `maxLines` formatted log lines for an issue (for Task.logTail). */
export async function readLogTail(
  issueNumber: number,
  maxLines = DEFAULT_TAIL_LINES
): Promise<string[]> {
  const events = await readLogEvents(issueNumber, maxLines);
  return events.map(renderLogLine);
}
