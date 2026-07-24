import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RepoInfo } from '@/lib/types';

/**
 * Repo registry — the list of local git repos this orchestrator manages.
 *
 * Persisted at <app-root>/data/repos.json (git-ignored) as {repos: [{id, name, path}]}.
 * Everything per-repo (state, logs, worktrees, goal/memory, planning) lives
 * inside each managed repo under .orchestrator/ and .worktrees/ — this file
 * only maps repo ids to checkout paths.
 *
 * Writes are atomic (temp file + rename), like state.ts. The registry is read
 * from disk on every access (it is tiny and rarely changes), so there is no
 * in-memory cache to keep coherent across Next dev hot-reloads.
 */

const execFileAsync = promisify(execFile);

const DATA_DIR = path.join(process.cwd(), 'data');
const REGISTRY_FILE = path.join(DATA_DIR, 'repos.json');

/**
 * One-time migration: the repo the pre-multi-repo orchestrator was hardcoded
 * to. If the registry file does not exist yet and this checkout does, seed the
 * registry with it so the existing user's state carries over.
 */
const LEGACY_REPO_PATH = '/Users/george-xon/Downloads/Git/nous-ai';

/** Registry entry as stored on disk (hasPersonas is computed, never stored). */
interface RepoEntry {
  id: string;
  name: string;
  path: string;
}

/** Both planning persona files a repo needs under .claude/agents/. */
const PERSONA_FILES = ['principal-engineer.md', 'product-manager.md'] as const;

// ---------------------------------------------------------------------------
// Registry persistence
// ---------------------------------------------------------------------------

/** Filesystem-safe slug of the basename + short hash of the absolute path. */
function repoId(absPath: string): string {
  const slug =
    path
      .basename(absPath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo';
  const hash = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

function entryFor(absPath: string, name?: string): RepoEntry {
  return {
    id: repoId(absPath),
    name: name?.trim() || path.basename(absPath),
    path: absPath,
  };
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fsp.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** Atomic write of repos.json (temp file + rename). */
async function saveRegistry(repos: RepoEntry[]): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${REGISTRY_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ repos }, null, 2), 'utf8');
  await fsp.rename(tmp, REGISTRY_FILE);
}

/** Read the registry, running the one-time legacy seed if it doesn't exist yet. */
async function readRegistry(): Promise<RepoEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(REGISTRY_FILE, 'utf8');
  } catch {
    // No registry yet — seed with the legacy hardcoded repo if it's present.
    if (await isDirectory(LEGACY_REPO_PATH)) {
      const seeded = [entryFor(LEGACY_REPO_PATH)];
      await saveRegistry(seeded);
      return seeded;
    }
    return [];
  }
  const parsed = JSON.parse(raw) as { repos?: RepoEntry[] };
  return (parsed.repos ?? []).filter(
    (entry) =>
      typeof entry?.id === 'string' &&
      typeof entry?.name === 'string' &&
      typeof entry?.path === 'string'
  );
}

/** Which planning persona files exist under .claude/agents/ (engineer, pm). */
async function personaPresence(repoPath: string): Promise<{ engineer: boolean; pm: boolean }> {
  const [engineer, pm] = await Promise.all(
    PERSONA_FILES.map((file) =>
      fsp.access(path.join(repoPath, '.claude', 'agents', file)).then(
        () => true,
        () => false
      )
    )
  );
  return { engineer, pm };
}

/** Normalize a git remote URL (https or ssh form) to a GitHub web URL. */
function remoteToHtmlUrl(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/, '');
  const ssh = trimmed.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return undefined;
}

/** GitHub web URL of the repo's `origin` remote, if resolvable. */
async function originHtmlUrl(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
    });
    return remoteToHtmlUrl(stdout);
  } catch {
    return undefined;
  }
}

/** Entry + computed fields (hasPersonas, htmlUrl) as served by GET /api/repos. */
async function toRepoInfo(entry: RepoEntry): Promise<RepoInfo> {
  const [personas, htmlUrl] = await Promise.all([
    personaPresence(entry.path),
    originHtmlUrl(entry.path),
  ]);
  return {
    ...entry,
    personas,
    hasPersonas: personas.engineer && personas.pm,
    ...(htmlUrl ? { htmlUrl } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All registered repos with hasPersonas computed (backs GET /api/repos). */
export async function loadRepos(): Promise<RepoInfo[]> {
  const entries = await readRegistry();
  return Promise.all(entries.map(toRepoInfo));
}

/** Look up one registered repo by id. Throws on unknown id. */
export async function getRepo(id: string): Promise<RepoInfo> {
  const entries = await readRegistry();
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown repo id: ${id}`);
  return entry;
}

/**
 * Register a local git repo by absolute path. Validates that the path is an
 * existing directory, a git repository, and has an `origin` remote (GitHub).
 * Re-adding an already-registered path returns the existing entry.
 */
const GIT_URL_PATTERN = /^(https?:\/\/|git@|ssh:\/\/)/;

/** Where cloned repos land: next to the first registered repo, else ~/git. */
async function cloneDestinationDir(): Promise<string> {
  const entries = await readRegistry();
  if (entries.length > 0) return path.dirname(entries[0].path);
  return path.join(os.homedir(), 'git');
}

/** Clone a git URL locally and return the clone's path (reuses an existing clone). */
async function cloneFromUrl(url: string): Promise<string> {
  const name = url
    .replace(/\/+$/, '')
    .split('/')
    .pop()
    ?.replace(/\.git$/, '');
  if (!name) throw new Error(`Cannot derive a repo name from url: ${url}`);
  const parent = await cloneDestinationDir();
  const dest = path.join(parent, name);
  if (await isDirectory(dest)) return dest; // already cloned — just register it
  await fsp.mkdir(parent, { recursive: true });
  try {
    await execFileAsync('git', ['clone', url, dest], { maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr ?? e.message ?? '').toString().trim().slice(0, 300);
    throw new Error(`git clone failed: ${detail}`);
  }
  return dest;
}

export async function addRepo(inputPath: string, name?: string): Promise<RepoInfo> {
  let target = inputPath.trim();
  // A git URL (https://github.com/... or git@...) is cloned locally first.
  if (GIT_URL_PATTERN.test(target)) {
    target = await cloneFromUrl(target);
  }
  if (!path.isAbsolute(target)) {
    throw new Error(`Repo path must be absolute (or a git URL to clone): ${target}`);
  }
  const absPath = path.resolve(target);
  if (!(await isDirectory(absPath))) {
    throw new Error(`Not a directory: ${absPath}`);
  }
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: absPath });
  } catch {
    throw new Error(`Not a git repository: ${absPath}`);
  }
  try {
    await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: absPath });
  } catch {
    throw new Error(
      `No GitHub remote: ${absPath} has no "origin" remote (git remote get-url origin failed)`
    );
  }

  const entries = await readRegistry();
  const existing = entries.find((candidate) => candidate.path === absPath);
  if (existing) {
    // Re-adding lets the developer rename the entry.
    if (name?.trim() && existing.name !== name.trim()) {
      existing.name = name.trim();
      await saveRegistry(entries);
    }
    return toRepoInfo(existing);
  }

  const entry = entryFor(absPath, name);
  await saveRegistry([...entries, entry]);
  return toRepoInfo(entry);
}

/**
 * Remove a repo from the registry only — never touches the repo's files
 * (.orchestrator/, .worktrees/ stay intact). Returns false on unknown id.
 */
export async function removeRepo(id: string): Promise<boolean> {
  const entries = await readRegistry();
  const remaining = entries.filter((candidate) => candidate.id !== id);
  if (remaining.length === entries.length) return false;
  await saveRegistry(remaining);
  return true;
}
