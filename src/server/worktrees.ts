/**
 * Git worktree management.
 *
 * Worktrees live at <repoPath>/.worktrees/issue-{n} on branch agent/issue-{n}
 * (both git-ignored). One worktree per issue; agents never touch the main checkout.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';

const execFileAsync = promisify(execFile);

export interface Worktree {
  issueNumber: number;
  path: string;
  branch: string;
}

function worktreesDir(repoPath: string): string {
  return path.join(repoPath, '.worktrees');
}

function worktreePath(repoPath: string, issueNumber: number): string {
  return path.join(worktreesDir(repoPath), `issue-${issueNumber}`);
}

function branchName(issueNumber: number): string {
  return `agent/issue-${issueNumber}`;
}

function assertValidIssueNumber(issueNumber: number): void {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number: ${issueNumber}`);
  }
}

/** Refuse to operate on any path outside <repoPath>/.worktrees/. */
function assertInsideWorktreesDir(repoPath: string, candidate: string): void {
  const dir = path.resolve(worktreesDir(repoPath));
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(dir + path.sep)) {
    throw new Error(
      `Refusing to operate on path outside ${dir}: ${resolved}`,
    );
  }
}

/** Run a git command from the managed repo's root. */
async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Default branch of `origin` (e.g. "master" or "main"), cached per repo path.
 * Reads the local origin/HEAD symref; if it was never set (repo cloned oddly
 * or remote added by hand), asks the remote once via `git remote set-head`.
 */
const defaultBranchCache = new Map<string, Promise<string>>();
export function getDefaultBranch(repoPath: string): Promise<string> {
  let cached = defaultBranchCache.get(repoPath);
  if (!cached) {
    cached = resolveDefaultBranch(repoPath).catch((err) => {
      defaultBranchCache.delete(repoPath); // allow retry on next call
      throw err;
    });
    defaultBranchCache.set(repoPath, cached);
  }
  return cached;
}

async function resolveDefaultBranch(repoPath: string): Promise<string> {
  let ref: string;
  try {
    ref = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  } catch {
    await git(repoPath, ['remote', 'set-head', 'origin', '--auto']);
    ref = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  }
  const branch = ref.trim().replace(/^origin\//, '');
  if (!branch) {
    throw new Error(`Could not resolve the default branch of origin in ${repoPath}`);
  }
  return branch;
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Create (or reuse) the worktree + branch for an issue and return its info. */
export async function createWorktree(repoPath: string, issueNumber: number): Promise<Worktree> {
  assertValidIssueNumber(issueNumber);
  const wtPath = worktreePath(repoPath, issueNumber);
  const branch = branchName(issueNumber);
  assertInsideWorktreesDir(repoPath, wtPath);

  // Reuse path: worktree already registered for this path (retry path).
  const existing = (await listWorktrees(repoPath)).find(
    (wt) => wt.issueNumber === issueNumber,
  );
  if (existing) {
    return existing;
  }

  await git(repoPath, ['fetch', 'origin']);

  // Stale directory left behind without a registered worktree — prune first.
  if (fs.existsSync(wtPath)) {
    await git(repoPath, ['worktree', 'prune']);
    if (fs.existsSync(wtPath)) {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(worktreesDir(repoPath), { recursive: true });

  if (await branchExists(repoPath, branch)) {
    // Branch already exists (retry path) — attach a worktree to it, never delete it.
    await git(repoPath, ['worktree', 'add', wtPath, branch]);
  } else {
    const baseRef = `origin/${await getDefaultBranch(repoPath)}`;
    await git(repoPath, ['worktree', 'add', '-b', branch, wtPath, baseRef]);
  }

  return { issueNumber, path: wtPath, branch };
}

/** Remove an issue's worktree (and prune); the branch is left in place. */
export async function removeWorktree(repoPath: string, issueNumber: number): Promise<void> {
  assertValidIssueNumber(issueNumber);
  const wtPath = worktreePath(repoPath, issueNumber);
  assertInsideWorktreesDir(repoPath, wtPath);

  const registered = (await listWorktrees(repoPath)).some(
    (wt) => wt.issueNumber === issueNumber,
  );
  if (registered) {
    await git(repoPath, ['worktree', 'remove', '--force', wtPath]);
  } else if (fs.existsSync(wtPath)) {
    // Directory exists but git no longer tracks it — clean it up directly.
    fs.rmSync(wtPath, { recursive: true, force: true });
  }
  await git(repoPath, ['worktree', 'prune']);
  // NOTE: the branch agent/issue-{n} is intentionally never deleted.
}

/** Push an issue's branch to origin (developer-triggered from the dashboard). */
export async function pushBranch(repoPath: string, issueNumber: number): Promise<void> {
  assertValidIssueNumber(issueNumber);
  const wtPath = worktreePath(repoPath, issueNumber);
  assertInsideWorktreesDir(repoPath, wtPath);
  await git(repoPath, ['-C', wtPath, 'push', '-u', 'origin', branchName(issueNumber)]);
}

/** List orchestrator-managed worktrees currently present under <repoPath>/.worktrees/. */
export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const stdout = await git(repoPath, ['worktree', 'list', '--porcelain']);
  const worktrees: Worktree[] = [];
  const dir = path.resolve(worktreesDir(repoPath));

  // Porcelain output: blocks separated by blank lines, each starting with
  // "worktree <path>" and (for non-detached checkouts) a "branch refs/heads/<name>" line.
  for (const block of stdout.split('\n\n')) {
    let wtPath: string | null = null;
    let branch: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      }
    }
    if (!wtPath || !branch) continue;

    const resolved = path.resolve(wtPath);
    if (!resolved.startsWith(dir + path.sep)) continue;

    const match = /^issue-(\d+)$/.exec(path.basename(resolved));
    if (!match) continue;

    worktrees.push({
      issueNumber: Number(match[1]),
      path: resolved,
      branch,
    });
  }

  return worktrees;
}
