/**
 * Git worktree management.
 *
 * Worktrees live at <repo-root>/.worktrees/issue-{n} on branch agent/issue-{n}
 * (both git-ignored). One worktree per issue; agents never touch the main checkout.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';

const execFileAsync = promisify(execFile);

const REPO_ROOT = '/Users/george-xon/Downloads/Git/nous-ai';
const WORKTREES_DIR = path.join(REPO_ROOT, '.worktrees');
const BASE_REF = 'origin/master';

export interface Worktree {
  issueNumber: number;
  path: string;
  branch: string;
}

function worktreePath(issueNumber: number): string {
  return path.join(WORKTREES_DIR, `issue-${issueNumber}`);
}

function branchName(issueNumber: number): string {
  return `agent/issue-${issueNumber}`;
}

function assertValidIssueNumber(issueNumber: number): void {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number: ${issueNumber}`);
  }
}

/** Refuse to operate on any path outside <repo-root>/.worktrees/. */
function assertInsideWorktreesDir(candidate: string): void {
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(WORKTREES_DIR + path.sep)) {
    throw new Error(
      `Refusing to operate on path outside ${WORKTREES_DIR}: ${resolved}`,
    );
  }
}

/** Run a git command from the repo root. */
async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function branchExists(branch: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Create (or reuse) the worktree + branch for an issue and return its info. */
export async function createWorktree(issueNumber: number): Promise<Worktree> {
  assertValidIssueNumber(issueNumber);
  const wtPath = worktreePath(issueNumber);
  const branch = branchName(issueNumber);
  assertInsideWorktreesDir(wtPath);

  // Reuse path: worktree already registered for this path (retry path).
  const existing = (await listWorktrees()).find(
    (wt) => wt.issueNumber === issueNumber,
  );
  if (existing) {
    return existing;
  }

  await git(['fetch', 'origin']);

  // Stale directory left behind without a registered worktree — prune first.
  if (fs.existsSync(wtPath)) {
    await git(['worktree', 'prune']);
    if (fs.existsSync(wtPath)) {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  if (await branchExists(branch)) {
    // Branch already exists (retry path) — attach a worktree to it, never delete it.
    await git(['worktree', 'add', wtPath, branch]);
  } else {
    await git(['worktree', 'add', '-b', branch, wtPath, BASE_REF]);
  }

  return { issueNumber, path: wtPath, branch };
}

/** Remove an issue's worktree (and prune); the branch is left in place. */
export async function removeWorktree(issueNumber: number): Promise<void> {
  assertValidIssueNumber(issueNumber);
  const wtPath = worktreePath(issueNumber);
  assertInsideWorktreesDir(wtPath);

  const registered = (await listWorktrees()).some(
    (wt) => wt.issueNumber === issueNumber,
  );
  if (registered) {
    await git(['worktree', 'remove', '--force', wtPath]);
  } else if (fs.existsSync(wtPath)) {
    // Directory exists but git no longer tracks it — clean it up directly.
    fs.rmSync(wtPath, { recursive: true, force: true });
  }
  await git(['worktree', 'prune']);
  // NOTE: the branch agent/issue-{n} is intentionally never deleted.
}

/** Push an issue's branch to origin (developer-triggered from the dashboard). */
export async function pushBranch(issueNumber: number): Promise<void> {
  assertValidIssueNumber(issueNumber);
  const wtPath = worktreePath(issueNumber);
  assertInsideWorktreesDir(wtPath);
  await git(['-C', wtPath, 'push', '-u', 'origin', branchName(issueNumber)]);
}

/** List orchestrator-managed worktrees currently present under .worktrees/. */
export async function listWorktrees(): Promise<Worktree[]> {
  const stdout = await git(['worktree', 'list', '--porcelain']);
  const worktrees: Worktree[] = [];

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
    if (!resolved.startsWith(WORKTREES_DIR + path.sep)) continue;

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
