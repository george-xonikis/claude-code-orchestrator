import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Orchestrator settings, all plain markdown files in <repoPath>/.orchestrator/
 * (git-ignored, hand-editable):
 * - goal.md — the project GOAL, injected into BOTH planning and execution.
 * - memory.md — EXECUTION memory: codebase gotchas execution agents hit, appended
 *   via the save_memory MCP tool and injected into execution task prompts.
 * - planning-memory.md — PLANNING memory: prioritization guidance for the PE/PM
 *   personas (what's worth proposing, what the developer keeps rejecting).
 *   Injected into planning passes; dismiss reasons are appended to it.
 */

export interface OrchestratorSettings {
  goal: string;
  memory: string;
  planningMemory: string;
}

function orchDir(repoPath: string): string {
  return path.join(repoPath, '.orchestrator');
}

function goalFile(repoPath: string): string {
  return path.join(orchDir(repoPath), 'goal.md');
}

function memoryFile(repoPath: string): string {
  return path.join(orchDir(repoPath), 'memory.md');
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
  const [goal, memory, planningMemory] = await Promise.all([
    readFileOrEmpty(goalFile(repoPath)),
    readFileOrEmpty(memoryFile(repoPath)),
    readFileOrEmpty(planningMemoryFile(repoPath)),
  ]);
  return { goal, memory, planningMemory };
}

export async function writeSettings(
  repoPath: string,
  patch: Partial<OrchestratorSettings>
): Promise<void> {
  if (patch.goal !== undefined) await writeFileAtomic(repoPath, goalFile(repoPath), patch.goal);
  if (patch.memory !== undefined) await writeFileAtomic(repoPath, memoryFile(repoPath), patch.memory);
  if (patch.planningMemory !== undefined)
    await writeFileAtomic(repoPath, planningMemoryFile(repoPath), patch.planningMemory);
}

/** Append a line to a memory file, adding a leading newline only when needed. */
async function appendLine(file: string, line: string): Promise<string> {
  const current = await readFileOrEmpty(file);
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  return `${current}${separator}${line}\n`;
}

/** Append one agent lesson to memory.md, stamped with its issue number. */
export async function appendMemory(
  repoPath: string,
  issueNumber: number,
  lesson: string
): Promise<void> {
  const trimmed = lesson.trim();
  if (!trimmed) return;
  const file = memoryFile(repoPath);
  await writeFileAtomic(repoPath, file, await appendLine(file, `- [#${issueNumber}] ${trimmed}`));
}

/** Append one dismissal reason to planning-memory.md so future passes learn from it. */
export async function appendPlanningMemory(repoPath: string, note: string): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) return;
  const file = planningMemoryFile(repoPath);
  await writeFileAtomic(repoPath, file, await appendLine(file, `- ${trimmed}`));
}
