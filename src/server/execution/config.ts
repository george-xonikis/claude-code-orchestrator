import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { dataDir } from '@/server/core/data-dir';
import { DEFAULT_EXECUTION_MODEL, isKnownModel } from '@/lib/models';
import { sanitizeManualQueue } from '@/lib/queue-order';
import type { RepoInfo } from '@/lib/types';

/**
 * Per-repo EXECUTION config — the knobs that govern how agent sessions run and
 * how the auto-pickup loop drains ready issues. Persisted in
 * <repoPath>/.claude-hydra/execution.json, separate from planning.json.
 *
 * Session-management knobs only: what agents may do is the managed repo's
 * business (its CLAUDE.md and .claude/ rules), never configured here. Existing
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
  /** Model agent sessions run on; a ticket's own preferredModel overrides it. */
  executionModel: string;
  /** Issue numbers the developer arranged by hand; they drain first, in this order. */
  manualQueue: number[];
}

const DEFAULTS: ExecutionConfig = {
  autoStart: false,
  queueOrder: 'oldest',
  maxActive: 2,
  tasksPerRun: null,
  pollMinutes: 2,
  executionModel: DEFAULT_EXECUTION_MODEL,
  manualQueue: [],
};

function executionFile(repoPath: string): string {
  return path.join(dataDir(repoPath), 'execution.json');
}

function planningFile(repoPath: string): string {
  return path.join(dataDir(repoPath), 'planning.json');
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;

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
    // Unknown/removed model ids fall back to the default rather than failing at
    // session start.
    executionModel: isKnownModel(src.executionModel)
      ? src.executionModel
      : DEFAULTS.executionModel,
    manualQueue: sanitizeManualQueue(src.manualQueue),
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
  if (patch.executionModel !== undefined && isKnownModel(patch.executionModel))
    store.executionModel = patch.executionModel;
  if (patch.manualQueue !== undefined) store.manualQueue = sanitizeManualQueue(patch.manualQueue);
  await saveStore(repo.path, store);
  return store;
}
