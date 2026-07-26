import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Hydra's per-repo data directory: <repo>/.claude-hydra (git-ignored).
 * Holds state.json, logs/, goal.md, memory.md, planning-memory.md,
 * planning.json, execution.json, and prompts/ overrides.
 *
 * Renamed from the legacy `.orchestrator`. `migrateLegacyDataDir()` runs once
 * per repo per process (called from the repo registry, so it precedes any
 * read/write): it renames the old directory in place, appends the new name to
 * the repo's .gitignore when the old one was listed, and rewrites textual
 * `.orchestrator/` references inside the repo's .claude/agents/*.md personas
 * (they point agents at goal.md by path).
 */

export const DATA_DIR_NAME = '.claude-hydra';
const LEGACY_DIR_NAME = '.orchestrator';

/** Absolute path of a repo's Hydra data directory. */
export function dataDir(repoPath: string): string {
  return path.join(repoPath, DATA_DIR_NAME);
}

const globalRef = globalThis as typeof globalThis & {
  __hydraDataDirMigrated?: Set<string>;
};

function migratedSet(): Set<string> {
  globalRef.__hydraDataDirMigrated ??= new Set();
  return globalRef.__hydraDataDirMigrated;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fsp.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Rewrite `.orchestrator/` → `.claude-hydra/` inside the repo's persona/agent files. */
async function rewriteAgentReferences(repoPath: string): Promise<void> {
  const agentsDir = path.join(repoPath, '.claude', 'agents');
  let files: string[];
  try {
    files = await fsp.readdir(agentsDir);
  } catch {
    return;
  }
  await Promise.all(
    files
      .filter((file) => file.endsWith('.md'))
      .map(async (file) => {
        const filePath = path.join(agentsDir, file);
        const raw = await fsp.readFile(filePath, 'utf8').catch(() => null);
        if (raw === null || !raw.includes(`${LEGACY_DIR_NAME}/`)) return;
        await fsp.writeFile(
          filePath,
          raw.replaceAll(`${LEGACY_DIR_NAME}/`, `${DATA_DIR_NAME}/`),
          'utf8'
        );
      })
  );
}

/** Add `.claude-hydra/` to the repo's .gitignore if it ignored the legacy dir but not the new one. */
async function updateGitignore(repoPath: string): Promise<void> {
  const gitignore = path.join(repoPath, '.gitignore');
  const raw = await fsp.readFile(gitignore, 'utf8').catch(() => null);
  if (raw === null) return;
  if (!raw.includes(LEGACY_DIR_NAME) || raw.includes(DATA_DIR_NAME)) return;
  const separator = raw.endsWith('\n') ? '' : '\n';
  await fsp.writeFile(gitignore, `${raw}${separator}${DATA_DIR_NAME}/\n`, 'utf8');
}

/**
 * One-time (per repo per process) migration from `.orchestrator` to
 * `.claude-hydra`. Safe to call often; never throws (a failed migration only
 * means the repo starts fresh, and the next call retries).
 */
export async function migrateLegacyDataDir(repoPath: string): Promise<void> {
  if (migratedSet().has(repoPath)) return;
  migratedSet().add(repoPath);
  try {
    const legacy = path.join(repoPath, LEGACY_DIR_NAME);
    if ((await exists(legacy)) && !(await exists(dataDir(repoPath)))) {
      await fsp.rename(legacy, dataDir(repoPath));
    }
    await updateGitignore(repoPath);
    await rewriteAgentReferences(repoPath);
  } catch (err) {
    migratedSet().delete(repoPath); // retry on next access
    console.error(
      `[hydra] data-dir migration failed for ${repoPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
