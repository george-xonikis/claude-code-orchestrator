import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { PlanningPass, PlanningProposal, RepoInfo } from '@/lib/types';
import { createIssue } from './github';
import { readSettings } from './settings';

/**
 * Planning passes: run the principal-engineer and product-manager agents in
 * parallel (read-only, against the repo's MAIN checkout — no worktree),
 * synthesize their reports into a deduped proposal list, and store it for the
 * /planning page. Issues are created ONLY when the developer approves them there.
 *
 * The agent prompts are each managed repo's own .claude/agents/*.md definitions
 * (single source of truth — edit those files to tune the agents). Everything —
 * store, run state, auto-run scheduler — is per repo, keyed by repo id.
 */

/** Planning persona definition files, relative to the repo root. */
const PERSONA_FILES = {
  engineer: '.claude/agents/principal-engineer.md',
  pm: '.claude/agents/product-manager.md',
} as const;

function planningFile(repoPath: string): string {
  return path.join(repoPath, '.orchestrator', 'planning.json');
}

interface RepoPlanningState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  armedHours: number | null;
}

interface PlanningGlobal {
  repos: Map<string, RepoPlanningState>;
}

const globalRef = globalThis as typeof globalThis & {
  __orchestratorPlanning?: PlanningGlobal;
};

function planningState(repoId: string): RepoPlanningState {
  globalRef.__orchestratorPlanning ??= { repos: new Map() };
  const { repos } = globalRef.__orchestratorPlanning;
  let s = repos.get(repoId);
  if (!s) {
    s = { running: false, timer: null, armedHours: null };
    repos.set(repoId, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface PlanningStore {
  /** Auto-run every N hours; null = manual only. */
  intervalHours: number | null;
  passes: PlanningPass[];
}

async function loadStore(repoPath: string): Promise<PlanningStore> {
  try {
    const raw = await fsp.readFile(planningFile(repoPath), 'utf8');
    const parsed = JSON.parse(raw) as {
      intervalHours?: number | null;
      passes?: PlanningPass[];
    };
    return { intervalHours: parsed.intervalHours ?? null, passes: parsed.passes ?? [] };
  } catch {
    return { intervalHours: null, passes: [] };
  }
}

async function saveStore(repoPath: string, store: PlanningStore): Promise<void> {
  const file = planningFile(repoPath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function updatePass(
  repoPath: string,
  passId: string,
  update: (pass: PlanningPass) => void
): Promise<void> {
  const store = await loadStore(repoPath);
  const pass = store.passes.find((p) => p.id === passId);
  if (!pass) return;
  update(pass);
  await saveStore(repoPath, store);
}

export async function getPlanning(repo: RepoInfo): Promise<PlanningStore> {
  return loadStore(repo.path);
}

// ---------------------------------------------------------------------------
// Scheduler (auto-run every N hours; requires the dev server to be running)
// ---------------------------------------------------------------------------

/** Arm/re-arm a repo's auto-run timer to match its stored interval. Idempotent. */
export async function ensurePlanningScheduler(repo: RepoInfo): Promise<void> {
  const g = planningState(repo.id);
  const { intervalHours } = await loadStore(repo.path);
  const hours = intervalHours ?? null;
  if (g.armedHours === hours && (hours === null || g.timer !== null)) return;
  if (g.timer) {
    clearInterval(g.timer);
    g.timer = null;
  }
  g.armedHours = hours;
  if (hours !== null) {
    g.timer = setInterval(() => {
      // startPlanningPass throws if one is already running — that skip is fine.
      startPlanningPass(repo).catch(() => {});
    }, hours * 3_600_000);
  }
}

export async function setPlanningInterval(
  repo: RepoInfo,
  hours: number | null
): Promise<void> {
  const store = await loadStore(repo.path);
  store.intervalHours = hours;
  await saveStore(repo.path, store);
  await ensurePlanningScheduler(repo);
}

// ---------------------------------------------------------------------------
// Read-only agent sessions
// ---------------------------------------------------------------------------

/** Read-only command prefixes; every segment of a compound command must match. */
const READONLY_BASH_SEGMENT =
  /^(gh\s+(issue|pr|label)\s+(list|view)\b|git\s+(log|show|diff|status|branch)\b|ls\b|rg\b|grep\b|find\b|cat\b|head\b|tail\b|wc\b|echo\b|sort\b|uniq\b)/;

function isReadOnlyCommand(command: string): boolean {
  return command
    .split(/;|&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .every((segment) => READONLY_BASH_SEGMENT.test(segment));
}

const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'TodoWrite', 'Task']);

const readOnlyCanUseTool: CanUseTool = async (toolName, input) => {
  if (READONLY_TOOLS.has(toolName)) {
    return { behavior: 'allow', updatedInput: input };
  }
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (isReadOnlyCommand(command)) {
      return { behavior: 'allow', updatedInput: input };
    }
    return {
      behavior: 'deny',
      message:
        'Denied: planning sessions are strictly read-only (list/view/grep-style commands only).',
    };
  }
  return {
    behavior: 'deny',
    message: `Denied: planning sessions are read-only; the ${toolName} tool is not available.`,
  };
};

/** Planning runs on Fable; when its usage limit is hit, fall back to Opus. */
const PLANNING_MODEL = 'claude-fable-5';
const PLANNING_FALLBACK_MODEL = 'claude-opus-4-8';

function isUsageLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /limit|quota|overloaded|exhausted|insufficient|credit/i.test(message);
}

/** Run one query on the primary planning model, retrying once on Opus if limited. */
async function runPlanningQuery(
  repoPath: string,
  prompt: string,
  extras?: Parameters<typeof runQuery>[3]
): Promise<string> {
  try {
    return await runQuery(repoPath, prompt, PLANNING_MODEL, extras);
  } catch (err) {
    if (!isUsageLimitError(err)) throw err;
    console.warn(
      `[orchestrator] planning: ${PLANNING_MODEL} limited, falling back to ${PLANNING_FALLBACK_MODEL}`
    );
    return runQuery(repoPath, prompt, PLANNING_FALLBACK_MODEL, extras);
  }
}

/** Run one session in the repo's checkout and return its final text result. */
async function runQuery(
  repoPath: string,
  prompt: string,
  model: string,
  extras?: {
    mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
    allowedTools?: string[];
  }
): Promise<string> {
  const q = query({
    prompt,
    options: {
      cwd: repoPath,
      model,
      permissionMode: 'default',
      canUseTool: readOnlyCanUseTool,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      persistSession: false,
      ...(extras?.mcpServers ? { mcpServers: extras.mcpServers } : {}),
      ...(extras?.allowedTools ? { allowedTools: extras.allowedTools } : {}),
    },
  });
  let result = '';
  for await (const message of q) {
    if (message.type === 'result') {
      if (message.subtype === 'success' && !message.is_error) {
        result = message.result;
      } else {
        const detail =
          message.subtype === 'success'
            ? message.result
            : [message.subtype, ...('errors' in message ? (message.errors ?? []) : [])].join(': ');
        throw new Error(`planning session failed: ${detail}`.slice(0, 500));
      }
    }
  }
  if (!result.trim()) throw new Error('planning session returned no result');
  return result;
}

async function runPlanningAgent(
  repoPath: string,
  defFile: string,
  exclusions: string
): Promise<string> {
  const definition = await fsp.readFile(defFile, 'utf8');
  const body = definition.replace(/^---[\s\S]*?---\s*/, '');
  const preamble = [
    'Run a planning pass NOW on the repository you are in.',
    'Follow the role instructions below exactly. Do not edit anything and do not',
    'create issues — return your ranked proposals as your final message, in the',
    'output format the instructions specify.',
  ].join(' ');
  const sections = [preamble, exclusions, '---', body].filter(Boolean);
  return runPlanningQuery(repoPath, sections.join('\n\n'));
}

/**
 * Both persona definition files must exist in the repo before a pass can run.
 * Throws a clear error naming the expected files (surfaced on the Planning page).
 */
async function requirePersonaFiles(
  repo: RepoInfo
): Promise<{ engineer: string; pm: string }> {
  const engineer = path.join(repo.path, PERSONA_FILES.engineer);
  const pm = path.join(repo.path, PERSONA_FILES.pm);
  const missing: string[] = [];
  for (const [label, file] of [
    [PERSONA_FILES.engineer, engineer],
    [PERSONA_FILES.pm, pm],
  ] as const) {
    try {
      await fsp.access(file);
    } catch {
      missing.push(label);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Planning personas missing in ${repo.name}: create ${missing.join(
        ' and '
      )} (planning passes need both ${PERSONA_FILES.engineer} and ${PERSONA_FILES.pm} in the repo)`
    );
  }
  return { engineer, pm };
}

/**
 * Digest of every proposal from previous passes, so agents don't waste
 * investigation effort re-discovering work the developer already saw.
 */
function exclusionDigest(passes: PlanningPass[]): string {
  const dismissed = new Set<string>();
  const pending = new Set<string>();
  const filed = new Set<string>();
  for (const pass of passes) {
    for (const p of pass.proposals) {
      if (p.status === 'dismissed') dismissed.add(p.title);
      else if (p.status === 'pending') pending.add(p.title);
      else filed.add(p.issueNumber ? `${p.title} (open issue #${p.issueNumber})` : p.title);
    }
  }
  if (dismissed.size + pending.size + filed.size === 0) return '';
  const section = (label: string, items: Set<string>) =>
    items.size ? `${label}\n${[...items].map((t) => `- ${t}`).join('\n')}` : '';
  return [
    'PREVIOUSLY PROPOSED — do NOT re-propose any of these:',
    section(
      'Dismissed by the developer (rejected — only revisit one if you have materially NEW evidence, and state explicitly what changed):',
      dismissed
    ),
    section('Pending developer review (already proposed, awaiting a decision — skip entirely):', pending),
    section('Filed as issues (your open-backlog dedupe should catch these too):', filed),
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

function synthesisPrompt(engineerReport: string, pmReport: string, exclusions: string): string {
  return [
    'You are the synthesis step of a planning meeting between a Principal',
    'Engineer and a Product Manager. Their independent proposal lists are below.',
    'Merge them into ONE deduped list:',
    '- When both describe the same underlying work, merge into a single item',
    '  with source "both", combining the PM problem/outcome framing with the',
    "  engineer's code anchors.",
    '- Drop anything that serves no stated goal priority.',
    '- Keep at most 9 items, ranked by leverage.',
    ...(exclusions
      ? [
          '- BACKSTOP: drop any item matching the previously-proposed list below,',
          '  unless it explicitly states materially new evidence for a dismissed one.',
          '',
          exclusions,
        ]
      : []),
    '',
    'Respond with STRICT JSON ONLY (no prose, no code fences): an array of',
    'objects with keys: title (string, <=70 chars), body (markdown string with',
    '"## Problem", "## Proposed direction", "## Success criteria" sections),',
    'labels (array from: Bug, FE, BE, AI, Infra), source ("engineer"|"pm"|"both"),',
    'effort ("S"|"M"|"L" if known), impact ("high"|"medium" if known).',
    '',
    '=== PRINCIPAL ENGINEER REPORT ===',
    engineerReport,
    '',
    '=== PRODUCT MANAGER REPORT ===',
    pmReport,
  ].join('\n');
}

interface RawProposal {
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  source?: unknown;
  effort?: unknown;
  impact?: unknown;
}

function parseProposals(raw: string): PlanningProposal[] {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('synthesis returned no JSON array');
  const parsed = JSON.parse(text.slice(start, end + 1)) as RawProposal[];
  return parsed
    .filter((item) => typeof item.title === 'string' && typeof item.body === 'string')
    .map((item, index) => ({
      id: `p${index + 1}`,
      title: (item.title as string).slice(0, 120),
      body: item.body as string,
      labels: Array.isArray(item.labels)
        ? item.labels.filter((label): label is string => typeof label === 'string')
        : [],
      source:
        item.source === 'engineer' || item.source === 'pm' || item.source === 'both'
          ? item.source
          : 'both',
      effort: typeof item.effort === 'string' ? item.effort : undefined,
      impact: typeof item.impact === 'string' ? item.impact : undefined,
      status: 'pending' as const,
    }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Kick off a planning pass for a repo (engineer + PM in parallel, then synthesis). */
export async function startPlanningPass(repo: RepoInfo): Promise<string> {
  const g = planningState(repo.id);
  if (g.running) throw new Error('A planning pass is already running');
  const personas = await requirePersonaFiles(repo);
  g.running = true;

  const pass: PlanningPass = {
    id: `pass-${Date.now()}`,
    startedAt: new Date().toISOString(),
    status: 'running',
    proposals: [],
  };
  const store = await loadStore(repo.path);
  // Digest of prior proposals (before this pass) so agents skip re-proposing them.
  const exclusions = exclusionDigest(store.passes);
  store.passes.unshift(pass);
  await saveStore(repo.path, store);

  void (async () => {
    try {
      const [engineerReport, pmReport] = await Promise.all([
        runPlanningAgent(repo.path, personas.engineer, exclusions),
        runPlanningAgent(repo.path, personas.pm, exclusions),
      ]);
      const proposals = parseProposals(
        await runPlanningQuery(repo.path, synthesisPrompt(engineerReport, pmReport, exclusions))
      );
      await updatePass(repo.path, pass.id, (p) => {
        p.status = 'complete';
        p.proposals = proposals;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updatePass(repo.path, pass.id, (p) => {
        p.status = 'failed';
        p.error = message;
      }).catch(() => {});
    } finally {
      g.running = false;
    }
  })();

  return pass.id;
}

/** File the selected pending proposals as GitHub issues (label: proposed). */
export async function fileProposals(
  repo: RepoInfo,
  passId: string,
  proposalIds: string[]
): Promise<void> {
  const store = await loadStore(repo.path);
  const pass = store.passes.find((p) => p.id === passId);
  if (!pass) throw new Error(`Unknown planning pass ${passId}`);
  for (const id of proposalIds) {
    const proposal = pass.proposals.find((p) => p.id === id);
    if (!proposal || proposal.status !== 'pending') continue;
    const issue = await createIssue(repo.path, proposal.title, proposal.body, [
      ...proposal.labels,
      'proposed',
    ]);
    proposal.status = 'filed';
    proposal.issueNumber = issue.number;
    proposal.issueUrl = issue.url;
    await saveStore(repo.path, store); // persist after each so a mid-batch failure loses nothing
  }
}

/** Dismiss the selected pending proposals. */
export async function dismissProposals(
  repo: RepoInfo,
  passId: string,
  proposalIds: string[]
): Promise<void> {
  await updatePass(repo.path, passId, (pass) => {
    for (const id of proposalIds) {
      const proposal = pass.proposals.find((p) => p.id === id);
      if (proposal && proposal.status === 'pending') proposal.status = 'dismissed';
    }
  });
}

// ---------------------------------------------------------------------------
// Proposal discussion (the "Discuss" drawer on the planning page)
// ---------------------------------------------------------------------------

export interface DiscussionMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** Patch a proposal's content in place (discussion tool). */
async function updateProposalContent(
  repoPath: string,
  passId: string,
  proposalId: string,
  patch: { title?: string; body?: string; labels?: string[] }
): Promise<PlanningProposal> {
  let updated: PlanningProposal | undefined;
  await updatePass(repoPath, passId, (pass) => {
    const proposal = pass.proposals.find((p) => p.id === proposalId);
    if (!proposal) return;
    if (patch.title !== undefined) proposal.title = patch.title.slice(0, 120);
    if (patch.body !== undefined) proposal.body = patch.body;
    if (patch.labels !== undefined) proposal.labels = patch.labels;
    updated = proposal;
  });
  if (!updated) throw new Error(`Unknown proposal ${proposalId} in pass ${passId}`);
  return updated;
}

/** Add a new proposal to a pass (discussion "split" tool). */
async function addProposalToPass(
  repoPath: string,
  passId: string,
  data: { title: string; body: string; labels: string[]; effort?: string; impact?: string }
): Promise<PlanningProposal> {
  let created: PlanningProposal | undefined;
  await updatePass(repoPath, passId, (pass) => {
    const nextIndex =
      pass.proposals.reduce((max, p) => {
        const n = Number(p.id.replace(/^p/, ''));
        return Number.isFinite(n) ? Math.max(max, n) : max;
      }, 0) + 1;
    created = {
      id: `p${nextIndex}`,
      title: data.title.slice(0, 120),
      body: data.body,
      labels: data.labels,
      source: 'both',
      effort: data.effort,
      impact: data.impact,
      status: 'pending',
    };
    pass.proposals.push(created);
  });
  if (!created) throw new Error(`Unknown planning pass ${passId}`);
  return created;
}

function discussionPrompt(
  proposal: PlanningProposal,
  goal: string,
  messages: DiscussionMessage[]
): string {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'DEVELOPER' : 'YOU'}: ${m.text}`)
    .join('\n\n');
  return [
    'You are discussing ONE task proposal with the developer before it may be',
    'filed as a GitHub issue. Your working directory is the repository the',
    'proposal is about — read code (read-only) to verify claims when the',
    'discussion needs evidence. Be direct and concise; agree or push back on',
    'the merits, not to please.',
    '',
    'Tools:',
    '- `update_proposal` — apply changes the two of you agree on (partial:',
    '  title/body/labels). Keep bodies in "## Problem / ## Proposed direction /',
    '  ## Success criteria" form; labels only from: Bug, FE, BE, AI, Infra.',
    '- `create_proposal` — when you agree to split scope, create the new',
    '  proposal in the same pass (same body format).',
    'After a tool call, confirm in one sentence what changed. Never create',
    'GitHub issues — the developer files proposals from the UI.',
    '',
    '## Project goal',
    goal.trim() || '(no goal file)',
    '',
    '## Current proposal',
    JSON.stringify(proposal, null, 2),
    '',
    ...(transcript ? ['## Conversation so far', transcript, ''] : []),
    'Reply to the last developer message.',
  ].join('\n');
}

/**
 * One discussion turn: stateless per call — the client sends the transcript,
 * the reply comes back, and any tool-applied proposal edits are persisted.
 */
export async function discussProposal(
  repo: RepoInfo,
  passId: string,
  proposalId: string,
  messages: DiscussionMessage[]
): Promise<string> {
  const store = await loadStore(repo.path);
  const pass = store.passes.find((p) => p.id === passId);
  const proposal = pass?.proposals.find((p) => p.id === proposalId);
  if (!pass || !proposal) throw new Error(`Unknown proposal ${proposalId} in pass ${passId}`);

  const { goal } = await readSettings(repo.path);
  const tools = createSdkMcpServer({
    name: 'orchestrator',
    version: '1.0.0',
    tools: [
      tool(
        'update_proposal',
        'Apply agreed changes to the proposal under discussion. Provide only the fields to change.',
        {
          title: z.string().optional(),
          body: z.string().optional(),
          labels: z.array(z.string()).optional(),
        },
        async (patch) => {
          const updated = await updateProposalContent(repo.path, passId, proposalId, patch);
          return {
            content: [{ type: 'text', text: `Proposal updated: ${updated.title}` }],
          };
        }
      ),
      tool(
        'create_proposal',
        'Create an additional proposal in the same planning pass (e.g. when splitting scope).',
        {
          title: z.string(),
          body: z.string(),
          labels: z.array(z.string()),
          effort: z.string().optional(),
          impact: z.string().optional(),
        },
        async (data) => {
          const created = await addProposalToPass(repo.path, passId, data);
          return {
            content: [{ type: 'text', text: `Created proposal ${created.id}: ${created.title}` }],
          };
        }
      ),
    ],
  });

  return runPlanningQuery(repo.path, discussionPrompt(proposal, goal, messages), {
    mcpServers: { orchestrator: tools },
    allowedTools: ['mcp__orchestrator__update_proposal', 'mcp__orchestrator__create_proposal'],
  });
}
