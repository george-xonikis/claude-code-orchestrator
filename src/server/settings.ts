import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Orchestrator settings: the project GOAL and the shared agent MEMORY.
 *
 * Both live as plain markdown files in <repoPath>/.orchestrator/ (git-ignored,
 * hand-editable) and are injected into every agent session's task prompt.
 * The developer edits them from the /settings page; agents append memory
 * lessons through the save_memory MCP tool (never by writing files directly).
 */

export interface OrchestratorSettings {
  goal: string;
  memory: string;
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
  const [goal, memory] = await Promise.all([
    readFileOrEmpty(goalFile(repoPath)),
    readFileOrEmpty(memoryFile(repoPath)),
  ]);
  return { goal, memory };
}

export async function writeSettings(
  repoPath: string,
  patch: Partial<OrchestratorSettings>
): Promise<void> {
  if (patch.goal !== undefined) await writeFileAtomic(repoPath, goalFile(repoPath), patch.goal);
  if (patch.memory !== undefined) await writeFileAtomic(repoPath, memoryFile(repoPath), patch.memory);
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
  const current = await readFileOrEmpty(file);
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await writeFileAtomic(repoPath, file, `${current}${separator}- [#${issueNumber}] ${trimmed}\n`);
}
