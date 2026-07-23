/**
 * GitHub access for the orchestrator (via `gh` CLI against this repo).
 *
 * Label loop: agent-ready -> agent-working -> agent-pr / agent-failed
 * (plus agent-needs-input while a session is paused on a question).
 * Only issues labeled agent-ready are ever touched.
 *
 * Relies entirely on the developer's existing `gh` auth — no tokens here.
 * All invocations go through execFile with argument arrays (no shell).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

/** Run `gh` with args (never a shell string) from this package's cwd (inside the repo). */
async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
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

/** Ensure the orchestrator labels exist on the repo (idempotent, once per process). */
let labelsEnsured: Promise<void> | null = null;
function ensureAgentLabels(): Promise<void> {
  labelsEnsured ??= (async () => {
    for (const [name, { color, description }] of Object.entries(AGENT_LABELS)) {
      // --force updates in place if the label already exists (no error).
      await gh(['label', 'create', name, '--force', '--color', color, '--description', description]);
    }
  })().catch((err) => {
    labelsEnsured = null; // allow retry on next call
    throw err;
  });
  return labelsEnsured;
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
export async function listOpenIssues(): Promise<GitHubIssue[]> {
  const stdout = await gh([
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
export async function getIssue(issueNumber: number): Promise<GitHubIssue> {
  const stdout = await gh([
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
export async function setLabels(issueNumber: number, labels: string[]): Promise<void> {
  await ensureAgentLabels();
  const toRemove = AGENT_LABEL_NAMES.filter((name) => !labels.includes(name));
  const args = ['issue', 'edit', String(issueNumber)];
  for (const name of toRemove) args.push('--remove-label', name);
  for (const name of labels) args.push('--add-label', name);
  await gh(args);
}

/** Post a comment on an issue (e.g. failure summary, PR link). */
export async function commentOnIssue(issueNumber: number, body: string): Promise<void> {
  await gh(['issue', 'comment', String(issueNumber), '--body', body]);
}

/** Create a GitHub issue (planning-pass approvals). Ensures the `proposed` label exists. */
let proposedLabelEnsured: Promise<void> | null = null;
export async function createIssue(
  title: string,
  body: string,
  labels: string[]
): Promise<{ number: number; url: string }> {
  proposedLabelEnsured ??= gh([
    'label',
    'create',
    'proposed',
    '--force',
    '--color',
    'BFD4F2',
    '--description',
    'Proposed by a planning pass, pending pickup',
  ]).then(() => undefined);
  await proposedLabelEnsured.catch(() => {
    proposedLabelEnsured = null;
  });

  const args = ['issue', 'create', '--title', title, '--body', body];
  for (const label of labels) args.push('--label', label);
  const stdout = await gh(args);
  const url = stdout.trim().split('\n').pop() ?? '';
  const match = url.match(/\/issues\/(\d+)/);
  if (!match) {
    throw new Error(`gh issue create did not return an issue url (got: ${url})`);
  }
  return { number: Number(match[1]), url };
}

/** Open a PR for a pushed branch (developer-triggered from the dashboard). */
export async function createPullRequest(
  issueNumber: number,
  branch: string,
  title: string
): Promise<GitHubPullRequest> {
  const stdout = await gh([
    'pr',
    'create',
    '--base',
    'master',
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

/** Find an open PR whose head branch matches, or null if none exists. */
export async function findOpenPrForBranch(branch: string): Promise<GitHubPullRequest | null> {
  const stdout = await gh([
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
