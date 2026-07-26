/**
 * GitHub access for the orchestrator (via `gh` CLI against a managed repo).
 *
 * Label loop: agent-ready -> agent-working -> agent-pr / agent-failed
 * (plus agent-needs-input while a session is paused on a question).
 * Only issues labeled agent-ready are ever touched.
 *
 * Relies entirely on the developer's existing `gh` auth — no tokens here.
 * All invocations go through execFile with argument arrays (no shell), with
 * cwd set to the managed repo so `gh` resolves the right GitHub remote.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDefaultBranch } from '@/server/core/worktrees';

const execFileAsync = promisify(execFile);

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
}

export interface GitHubPullRequest {
  number: number;
  url: string;
}

/** Every label the orchestrator may add or remove, with create-time metadata. */
const AGENT_LABELS: Record<string, { color: string; description: string }> = {
  'agent-working': { color: 'FBCA04', description: 'An agent session is working on this issue' },
  'agent-pr': { color: '1D76DB', description: 'Agent opened a pull request for this issue' },
  'agent-failed': { color: 'B60205', description: 'Agent session failed on this issue' },
  'agent-needs-input': { color: '5319E7', description: 'Agent session paused on a question' },
  'agent-committed': { color: 'C5DEF5', description: 'Agent finished; awaiting developer push from the dashboard' },
};

const AGENT_LABEL_NAMES = Object.keys(AGENT_LABELS);

/** Run `gh` with args (never a shell string) from the managed repo's root. */
async function gh(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderr = e.stderr?.toString().trim();
    throw new Error(
      `gh ${args.join(' ')} failed: ${e.message}${stderr ? `\nstderr: ${stderr}` : ''}`,
    );
  }
}

/** Ensure the orchestrator labels exist on the repo (idempotent, once per repo per process). */
const labelsEnsured = new Map<string, Promise<void>>();
function ensureAgentLabels(repoPath: string): Promise<void> {
  let ensured = labelsEnsured.get(repoPath);
  if (!ensured) {
    ensured = (async () => {
      for (const [name, { color, description }] of Object.entries(AGENT_LABELS)) {
        // --force updates in place if the label already exists (no error).
        await gh(repoPath, ['label', 'create', name, '--force', '--color', color, '--description', description]);
      }
    })().catch((err) => {
      labelsEnsured.delete(repoPath); // allow retry on next call
      throw err;
    });
    labelsEnsured.set(repoPath, ensured);
  }
  return ensured;
}

interface IssueJson {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  assignees?: { login: string }[];
}

function toIssue(json: IssueJson): GitHubIssue {
  return {
    number: json.number,
    title: json.title,
    body: json.body ?? '',
    labels: json.labels.map((l) => l.name),
    assignees: (json.assignees ?? []).map((a) => a.login),
  };
}

/** List all open issues. */
/** True if the issue is closed (PR merged auto-closes it) or no longer exists. */
export async function issueIsClosed(repoPath: string, issueNumber: number): Promise<boolean> {
  try {
    const stdout = await gh(repoPath, ['issue', 'view', String(issueNumber), '--json', 'state']);
    const { state } = JSON.parse(stdout) as { state: string };
    return state.toUpperCase() === 'CLOSED';
  } catch {
    // Not found / gone — treat as closed so the stale task gets cleaned up.
    return true;
  }
}

export async function listOpenIssues(repoPath: string): Promise<GitHubIssue[]> {
  const stdout = await gh(repoPath, [
    'issue',
    'list',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,title,body,labels,assignees',
  ]);
  return (JSON.parse(stdout) as IssueJson[]).map(toIssue);
}

/**
 * Fetch a single issue (title, body, labels) by number.
 * Issue comments are appended to `body` under a "## Comments" section so the
 * agent prompt gets the full discussion (the GitHubIssue shape stays as stubbed).
 */
export async function getIssue(repoPath: string, issueNumber: number): Promise<GitHubIssue> {
  const stdout = await gh(repoPath, [
    'issue',
    'view',
    String(issueNumber),
    '--json',
    'number,title,body,labels,assignees,comments',
  ]);
  const json = JSON.parse(stdout) as IssueJson & {
    comments: { author: { login: string } | null; body: string }[];
  };
  const issue = toIssue(json);
  if (json.comments.length > 0) {
    const rendered = json.comments
      .map((c) => `**@${c.author?.login ?? 'unknown'}**:\n${c.body}`)
      .join('\n\n---\n\n');
    issue.body = `${issue.body}\n\n## Comments\n\n${rendered}`;
  }
  return issue;
}

/**
 * Replace the orchestrator labels on an issue: removes every other agent-*
 * label and adds `labels` in a single `gh issue edit` call (one API mutation).
 * Missing repo labels are created lazily first.
 */
export async function setLabels(repoPath: string, issueNumber: number, labels: string[]): Promise<void> {
  await ensureAgentLabels(repoPath);
  const toRemove = AGENT_LABEL_NAMES.filter((name) => !labels.includes(name));
  const args = ['issue', 'edit', String(issueNumber)];
  for (const name of toRemove) args.push('--remove-label', name);
  for (const name of labels) args.push('--add-label', name);
  await gh(repoPath, args);
}

/** Post a comment on an issue (e.g. failure summary, PR link). */
export async function commentOnIssue(repoPath: string, issueNumber: number, body: string): Promise<void> {
  await gh(repoPath, ['issue', 'comment', String(issueNumber), '--body', body]);
}

/** Raw title/body of one issue (for editing — no comments appended). */
export async function getIssueDetails(
  repoPath: string,
  issueNumber: number
): Promise<{ title: string; body: string }> {
  const stdout = await gh(repoPath, [
    'issue',
    'view',
    String(issueNumber),
    '--json',
    'title,body',
  ]);
  const json = JSON.parse(stdout) as { title: string; body: string | null };
  return { title: json.title, body: json.body ?? '' };
}

/** Edit an issue's title and/or body on GitHub. */
export async function editIssue(
  repoPath: string,
  issueNumber: number,
  patch: { title?: string; body?: string }
): Promise<void> {
  const args = ['issue', 'edit', String(issueNumber)];
  if (patch.title !== undefined) args.push('--title', patch.title);
  if (patch.body !== undefined) args.push('--body', patch.body);
  if (args.length === 3) return;
  await gh(repoPath, args);
}

/** Colors for the planning label taxonomy; anything else gets a neutral gray. */
const LABEL_COLORS: Record<string, string> = {
  proposed: 'BFD4F2',
  bug: 'D73A4A',
  fe: '1D76DB',
  be: '0E8A16',
  ai: '8E44AD',
  infra: 'FBCA04',
};

/** Per-repo map of existing labels, keyed by lowercase name -> actual name. */
const knownLabels = new Map<string, Map<string, string>>();

async function labelIndex(repoPath: string): Promise<Map<string, string>> {
  let index = knownLabels.get(repoPath);
  if (index) return index;
  index = new Map();
  try {
    const raw = await gh(repoPath, ['label', 'list', '--limit', '200', '--json', 'name']);
    for (const { name } of JSON.parse(raw) as { name: string }[]) {
      index.set(name.toLowerCase(), name);
    }
  } catch {
    // No labels yet / gh error — start empty; missing ones are created below.
  }
  knownLabels.set(repoPath, index);
  return index;
}

/**
 * Resolve requested labels to names that actually exist on the repo: reuse an
 * existing label that matches case-insensitively (so "Bug" maps to a repo's
 * "bug" rather than colliding), and create any genuinely missing ones. This
 * keeps `gh issue create --label` from failing on repos without the planning
 * taxonomy (proposed / Bug / FE / BE / AI / Infra).
 */
async function ensureLabels(repoPath: string, labels: string[]): Promise<string[]> {
  const index = await labelIndex(repoPath);
  const resolved: string[] = [];
  for (const label of labels) {
    const key = label.toLowerCase();
    const existing = index.get(key);
    if (existing) {
      resolved.push(existing);
      continue;
    }
    await gh(repoPath, ['label', 'create', label, '--force', '--color', LABEL_COLORS[key] ?? 'C5C5C5']);
    index.set(key, label);
    resolved.push(label);
  }
  return resolved;
}

/** Create a GitHub issue (planning-pass approvals). Ensures its labels exist first. */
export async function createIssue(
  repoPath: string,
  title: string,
  body: string,
  labels: string[]
): Promise<{ number: number; url: string }> {
  const resolved = await ensureLabels(repoPath, labels);

  const args = ['issue', 'create', '--title', title, '--body', body];
  for (const label of resolved) args.push('--label', label);
  const stdout = await gh(repoPath, args);
  const url = stdout.trim().split('\n').pop() ?? '';
  const match = url.match(/\/issues\/(\d+)/);
  if (!match) {
    throw new Error(`gh issue create did not return an issue url (got: ${url})`);
  }
  return { number: Number(match[1]), url };
}

/** Open a PR for a pushed branch (developer-triggered from the dashboard). */
export async function createPullRequest(
  repoPath: string,
  issueNumber: number,
  branch: string,
  title: string
): Promise<GitHubPullRequest> {
  const base = await getDefaultBranch(repoPath);
  const stdout = await gh(repoPath, [
    'pr',
    'create',
    '--base',
    base,
    '--head',
    branch,
    '--title',
    title,
    '--body',
    `Closes #${issueNumber}\n\n🤖 Generated by an orchestrator agent session.`,
  ]);
  const url = stdout.trim().split('\n').pop() ?? '';
  const match = url.match(/\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`gh pr create did not return a PR url (got: ${url})`);
  }
  return { number: Number(match[1]), url };
}

/** GitHub's computed merge state of a PR against its base branch. */
export type PrMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/**
 * Ask GitHub whether a PR is mergeable. UNKNOWN means GitHub is still
 * computing it (common right after a push) — treat it as "no change".
 */
export async function getPrMergeable(
  repoPath: string,
  prNumber: number
): Promise<PrMergeable> {
  const stdout = await gh(repoPath, [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'mergeable',
  ]);
  const { mergeable } = JSON.parse(stdout) as { mergeable?: string };
  return mergeable === 'MERGEABLE' || mergeable === 'CONFLICTING' ? mergeable : 'UNKNOWN';
}

/** Find an open PR whose head branch matches, or null if none exists. */
export async function findOpenPrForBranch(repoPath: string, branch: string): Promise<GitHubPullRequest | null> {
  const stdout = await gh(repoPath, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--limit',
    '1',
    '--json',
    'number,url',
  ]);
  const prs = JSON.parse(stdout) as { number: number; url: string }[];
  if (prs.length === 0) return null;
  return { number: prs[0].number, url: prs[0].url };
}
