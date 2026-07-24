import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { RepoInfo } from '@/lib/types';

/**
 * Per-repo EXECUTION config — the knobs that govern how agent sessions run and
 * how the auto-pickup loop drains ready issues. Persisted in
 * <repoPath>/.orchestrator/execution.json, separate from planning.json.
 *
 * Split out of the old catch-all planning config: these are execution concerns
 * (the loop, concurrency, the pre-commit review gate), not planning. Existing
 * repos are migrated once, on first read, from their legacy planning.json.
 */
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
}

const DEFAULTS: ExecutionConfig = {
  autoStart: false,
  queueOrder: 'oldest',
  maxActive: 2,
  tasksPerRun: null,
  pollMinutes: 2,
  reviewerAgents: [],
};

function executionFile(repoPath: string): string {
  return path.join(repoPath, '.orchestrator', 'execution.json');
}

function planningFile(repoPath: string): string {
  return path.join(repoPath, '.orchestrator', 'planning.json');
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;

/** Trim, drop blanks, de-dupe (lowercased), and cap the reviewer-agent list. */
function sanitizeReviewerAgents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, 100);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
    if (names.length >= 10) break;
  }
  return names;
}

/** Shape of the execution fields as they lived on the legacy planning.json. */
type LegacyFields = Partial<ExecutionConfig> & { autonomous?: boolean };

/** Read the execution fields from the legacy planning.json (for the one-time migration). */
async function readLegacyFields(repoPath: string): Promise<LegacyFields> {
  try {
    const raw = await fsp.readFile(planningFile(repoPath), 'utf8');
    return JSON.parse(raw) as LegacyFields;
  } catch {
    return {};
  }
}

/** Coerce a raw/partial source into a full, validated ExecutionConfig. */
function normalize(src: LegacyFields): ExecutionConfig {
  return {
    autoStart: src.autoStart ?? src.autonomous ?? DEFAULTS.autoStart,
    queueOrder: src.queueOrder === 'newest' ? 'newest' : 'oldest',
    maxActive: clampInt(src.maxActive, 1, 10, DEFAULTS.maxActive),
    tasksPerRun: src.tasksPerRun == null ? null : clampInt(src.tasksPerRun, 1, 100, 4),
    pollMinutes:
      src.pollMinutes === undefined ? 2 : src.pollMinutes === null ? null : clampInt(src.pollMinutes, 1, 60, 2),
    reviewerAgents: sanitizeReviewerAgents(src.reviewerAgents),
  };
}

async function loadStore(repoPath: string): Promise<ExecutionConfig> {
  try {
    const raw = await fsp.readFile(executionFile(repoPath), 'utf8');
    return normalize(JSON.parse(raw) as LegacyFields);
  } catch {
    // execution.json absent → one-time migration from the legacy planning.json.
    return normalize(await readLegacyFields(repoPath));
  }
}

async function saveStore(repoPath: string, config: ExecutionConfig): Promise<void> {
  const file = executionFile(repoPath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** Per-repo execution config, with defaults filled in. */
export async function getExecutionConfig(repo: RepoInfo): Promise<ExecutionConfig> {
  return loadStore(repo.path);
}

/** Patch execution config; values are validated/clamped, then persisted. */
export async function setExecutionConfig(
  repo: RepoInfo,
  patch: Partial<ExecutionConfig>
): Promise<ExecutionConfig> {
  const store = await loadStore(repo.path);
  if (patch.autoStart !== undefined) store.autoStart = patch.autoStart;
  if (patch.queueOrder !== undefined)
    store.queueOrder = patch.queueOrder === 'newest' ? 'newest' : 'oldest';
  if (patch.maxActive !== undefined) store.maxActive = clampInt(patch.maxActive, 1, 10, store.maxActive);
  if (patch.tasksPerRun !== undefined)
    store.tasksPerRun = patch.tasksPerRun === null ? null : clampInt(patch.tasksPerRun, 1, 100, 4);
  if (patch.pollMinutes !== undefined)
    store.pollMinutes =
      patch.pollMinutes === null ? null : clampInt(patch.pollMinutes, 1, 60, store.pollMinutes ?? 2);
  if (patch.reviewerAgents !== undefined)
    store.reviewerAgents = sanitizeReviewerAgents(patch.reviewerAgents);
  await saveStore(repo.path, store);
  return store;
}
