import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { dataDir } from '@/server/core/data-dir';

/**
 * Orchestrator settings, all plain markdown files in <repoPath>/.claude-hydra/
 * (git-ignored, hand-editable):
 * - goal.md — the project GOAL, injected into PLANNING only (personas,
 *   steering, proposal discussion). Execution agents work from the issue —
 *   planning already distilled the goal into it.
 * - planning-memory.md — PLANNING memory: prioritization guidance for the PE/PM
 *   personas (what's worth proposing, what the developer keeps rejecting).
 *   Injected into planning passes; dismiss reasons are appended to it.
 *
 * There is no execution memory: the managed repo's own CLAUDE.md/skills govern
 * how execution agents work, so Hydra keeps no parallel gotcha file.
 */

export interface OrchestratorSettings {
  goal: string;
  planningMemory: string;
}

function orchDir(repoPath: string): string {
  return dataDir(repoPath);
}

function goalFile(repoPath: string): string {
  return path.join(orchDir(repoPath), 'goal.md');
}

function planningMemoryFile(repoPath: string): string {
  return path.join(orchDir(repoPath), 'planning-memory.md');
}

async function readFileOrEmpty(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** Atomic write (temp file + rename), mirroring the state.json pattern. */
async function writeFileAtomic(repoPath: string, file: string, content: string): Promise<void> {
  await fsp.mkdir(orchDir(repoPath), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}

export async function readSettings(repoPath: string): Promise<OrchestratorSettings> {
  const [goal, planningMemory] = await Promise.all([
    readFileOrEmpty(goalFile(repoPath)),
    readFileOrEmpty(planningMemoryFile(repoPath)),
  ]);
  return { goal, planningMemory };
}

export async function writeSettings(
  repoPath: string,
  patch: Partial<OrchestratorSettings>
): Promise<void> {
  if (patch.goal !== undefined) await writeFileAtomic(repoPath, goalFile(repoPath), patch.goal);
  if (patch.planningMemory !== undefined)
    await writeFileAtomic(repoPath, planningMemoryFile(repoPath), patch.planningMemory);
}

/** Append a line to a memory file, adding a leading newline only when needed. */
async function appendLine(file: string, line: string): Promise<string> {
  const current = await readFileOrEmpty(file);
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  return `${current}${separator}${line}\n`;
}

/** Append one dismissal reason to planning-memory.md so future passes learn from it. */
export async function appendPlanningMemory(repoPath: string, note: string): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) return;
  const file = planningMemoryFile(repoPath);
  await writeFileAtomic(repoPath, file, await appendLine(file, `- ${trimmed}`));
}

/**
 * The repo's configured product-brief agent, read straight from
 * <dataDir>/planning.json (key `briefAgent`) so execution can decide whether
 * the product-map prompt section is active without importing the planning
 * layer. Returns null when unset, blank, or on any read/parse error.
 */
export async function getBriefAgent(repoPath: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(dataDir(repoPath), 'planning.json'), 'utf8');
    const parsed = JSON.parse(raw) as { briefAgent?: unknown };
    if (typeof parsed.briefAgent !== 'string') return null;
    const trimmed = parsed.briefAgent.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
