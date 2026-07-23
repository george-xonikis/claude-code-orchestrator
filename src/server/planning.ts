import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { PlanningPass, PlanningProposal } from '@/lib/types';
import { createIssue } from './github';

/**
 * Planning passes: run the principal-engineer and product-manager agents in
 * parallel (read-only, against the MAIN checkout — no worktree), synthesize
 * their reports into a deduped proposal list, and store it for the /planning
 * page. Issues are created ONLY when the developer approves proposals there.
 *
 * The agent prompts are the repo's own .claude/agents/*.md definitions
 * (single source of truth — edit those files to tune the agents).
 */

const REPO_ROOT = '/Users/george-xon/Downloads/Git/nous-ai';
const PLANNING_FILE = path.join(REPO_ROOT, '.orchestrator', 'planning.json');
const AGENT_DEFS = {
  engineer: path.join(REPO_ROOT, '.claude/agents/principal-engineer.md'),
  pm: path.join(REPO_ROOT, '.claude/agents/product-manager.md'),
} as const;

interface PlanningGlobal {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  armedHours: number | null;
}

const globalRef = globalThis as typeof globalThis & {
  __orchestratorPlanning?: PlanningGlobal;
};

function planningState(): PlanningGlobal {
  globalRef.__orchestratorPlanning ??= { running: false, timer: null, armedHours: null };
  return globalRef.__orchestratorPlanning;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface PlanningStore {
  /** Auto-run every N hours; null = manual only. */
  intervalHours: number | null;
  passes: PlanningPass[];
}

async function loadStore(): Promise<PlanningStore> {
  try {
    const raw = await fsp.readFile(PLANNING_FILE, 'utf8');
    const parsed = JSON.parse(raw) as {
      intervalHours?: number | null;
      passes?: PlanningPass[];
    };
    return { intervalHours: parsed.intervalHours ?? null, passes: parsed.passes ?? [] };
  } catch {
    return { intervalHours: null, passes: [] };
  }
}

async function saveStore(store: PlanningStore): Promise<void> {
  await fsp.mkdir(path.dirname(PLANNING_FILE), { recursive: true });
  const tmp = `${PLANNING_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fsp.rename(tmp, PLANNING_FILE);
}

async function updatePass(
  passId: string,
  update: (pass: PlanningPass) => void
): Promise<void> {
  const store = await loadStore();
  const pass = store.passes.find((p) => p.id === passId);
  if (!pass) return;
  update(pass);
  await saveStore(store);
}

export async function getPlanning(): Promise<PlanningStore> {
  return loadStore();
}

// ---------------------------------------------------------------------------
// Scheduler (auto-run every N hours; requires the dev server to be running)
// ---------------------------------------------------------------------------

/** Arm/re-arm the auto-run timer to match the stored interval. Idempotent. */
export async function ensurePlanningScheduler(): Promise<void> {
  const g = planningState();
  const { intervalHours } = await loadStore();
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
      startPlanningPass().catch(() => {});
    }, hours * 3_600_000);
  }
}

export async function setPlanningInterval(hours: number | null): Promise<void> {
  const store = await loadStore();
  store.intervalHours = hours;
  await saveStore(store);
  await ensurePlanningScheduler();
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

/** Run one session and return its final text result. */
async function runQuery(prompt: string): Promise<string> {
  const q = query({
    prompt,
    options: {
      cwd: REPO_ROOT,
      permissionMode: 'default',
      canUseTool: readOnlyCanUseTool,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      persistSession: false,
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

async function runPlanningAgent(defFile: string, exclusions: string): Promise<string> {
  const definition = await fsp.readFile(defFile, 'utf8');
  const body = definition.replace(/^---[\s\S]*?---\s*/, '');
  const preamble = [
    'Run a planning pass NOW on the repository you are in.',
    'Follow the role instructions below exactly. Do not edit anything and do not',
    'create issues — return your ranked proposals as your final message, in the',
    'output format the instructions specify.',
  ].join(' ');
  const sections = [preamble, exclusions, '---', body].filter(Boolean);
  return runQuery(sections.join('\n\n'));
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

/** Kick off a planning pass (engineer + PM in parallel, then synthesis). */
export async function startPlanningPass(): Promise<string> {
  const g = planningState();
  if (g.running) throw new Error('A planning pass is already running');
  g.running = true;

  const pass: PlanningPass = {
    id: `pass-${Date.now()}`,
    startedAt: new Date().toISOString(),
    status: 'running',
    proposals: [],
  };
  const store = await loadStore();
  // Digest of prior proposals (before this pass) so agents skip re-proposing them.
  const exclusions = exclusionDigest(store.passes);
  store.passes.unshift(pass);
  await saveStore(store);

  void (async () => {
    try {
      const [engineerReport, pmReport] = await Promise.all([
        runPlanningAgent(AGENT_DEFS.engineer, exclusions),
        runPlanningAgent(AGENT_DEFS.pm, exclusions),
      ]);
      const proposals = parseProposals(
        await runQuery(synthesisPrompt(engineerReport, pmReport, exclusions))
      );
      await updatePass(pass.id, (p) => {
        p.status = 'complete';
        p.proposals = proposals;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updatePass(pass.id, (p) => {
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
export async function fileProposals(passId: string, proposalIds: string[]): Promise<void> {
  const store = await loadStore();
  const pass = store.passes.find((p) => p.id === passId);
  if (!pass) throw new Error(`Unknown planning pass ${passId}`);
  for (const id of proposalIds) {
    const proposal = pass.proposals.find((p) => p.id === id);
    if (!proposal || proposal.status !== 'pending') continue;
    const issue = await createIssue(proposal.title, proposal.body, [
      ...proposal.labels,
      'proposed',
    ]);
    proposal.status = 'filed';
    proposal.issueNumber = issue.number;
    proposal.issueUrl = issue.url;
    await saveStore(store); // persist after each so a mid-batch failure loses nothing
  }
}

/** Dismiss the selected pending proposals. */
export async function dismissProposals(passId: string, proposalIds: string[]): Promise<void> {
  await updatePass(passId, (pass) => {
    for (const id of proposalIds) {
      const proposal = pass.proposals.find((p) => p.id === id);
      if (proposal && proposal.status === 'pending') proposal.status = 'dismissed';
    }
  });
}
