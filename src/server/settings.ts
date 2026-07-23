import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Orchestrator settings: the project GOAL and the shared agent MEMORY.
 *
 * Both live as plain markdown files in <repo-root>/.orchestrator/ (git-ignored,
 * hand-editable) and are injected into every agent session's task prompt.
 * The developer edits them from the /settings page; agents append memory
 * lessons through the save_memory MCP tool (never by writing files directly).
 */

const REPO_ROOT = '/Users/george-xon/Downloads/Git/nous-ai';
const ORCH_DIR = path.join(REPO_ROOT, '.orchestrator');
const GOAL_FILE = path.join(ORCH_DIR, 'goal.md');
const MEMORY_FILE = path.join(ORCH_DIR, 'memory.md');

export interface OrchestratorSettings {
  goal: string;
  memory: string;
}

async function readFileOrEmpty(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** Atomic write (temp file + rename), mirroring the state.json pattern. */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fsp.mkdir(ORCH_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}

export async function readSettings(): Promise<OrchestratorSettings> {
  const [goal, memory] = await Promise.all([
    readFileOrEmpty(GOAL_FILE),
    readFileOrEmpty(MEMORY_FILE),
  ]);
  return { goal, memory };
}

export async function writeSettings(patch: Partial<OrchestratorSettings>): Promise<void> {
  if (patch.goal !== undefined) await writeFileAtomic(GOAL_FILE, patch.goal);
  if (patch.memory !== undefined) await writeFileAtomic(MEMORY_FILE, patch.memory);
}

/** Append one agent lesson to memory.md, stamped with its issue number. */
export async function appendMemory(issueNumber: number, lesson: string): Promise<void> {
  const trimmed = lesson.trim();
  if (!trimmed) return;
  const current = await readFileOrEmpty(MEMORY_FILE);
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await writeFileAtomic(MEMORY_FILE, `${current}${separator}- [#${issueNumber}] ${trimmed}\n`);
}
