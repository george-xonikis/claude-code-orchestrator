import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { dataDir } from '@/server/core/data-dir';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { PlanningLogLine, PlanningPass, PlanningProposal, RepoInfo } from '@/lib/types';
import { isKnownModel } from '@/lib/models';
import { listRepoAgents } from '@/server/core/agents';
import { createIssue } from '@/server/core/github';
import {
  adHocChatPrompt,
  adHocDirectionBlock,
  CREATE_PROPOSAL_TOOL_DESCRIPTION,
  type DiscussionMessage,
  discussionPrompt,
  exclusionDigest,
  planningAgentPrompt,
  type ProposalShaping,
  synthesisPrompt,
  UPDATE_PROPOSAL_TOOL_DESCRIPTION,
} from '@/server/planning/prompts';
import { readPromptTemplate } from '@/server/knowledge/prompt-templates';
import { appendPlanningMemory, readSettings } from '@/server/knowledge/settings';

export type { DiscussionMessage } from '@/server/planning/prompts';

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

function planningFile(repoPath: string): string {
  return path.join(dataDir(repoPath), 'planning.json');
}

interface RepoPlanningState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  armedHours: number | null;
  /** Aborts the in-flight pass's agent queries when the developer cancels. */
  abort: AbortController | null;
  /** Set when the current pass was cancelled, so it's marked cancelled not failed. */
  cancelled: boolean;
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
    s = { running: false, timer: null, armedHours: null, abort: null, cancelled: false };
    repos.set(repoId, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Which planning agents a pass runs. */
export type PlanningRole = 'engineer' | 'pm';

/** Max focus topics a plan may be steered toward. */
export const MAX_PLANNING_TOPICS = 3;

/**
 * Per-repo planning configuration — every knob is independent.
 * Persisted in planning.json alongside the passes.
 */
export interface PlanningConfig {
  /** Auto-run every N hours; null = manual only. */
  intervalHours: number | null;
  /** Which agents scheduled/auto passes run (manual runs pass their own scope). */
  roles: PlanningRole[];
  /** Auto-file a scheduled pass's top proposals as issues. */
  autoFile: boolean;
  /** Max top-ranked proposals a scheduled pass may auto-file per run. */
  maxAutoFile: number;
  /** Max proposals a pass produces (synthesis cap). */
  maxProposals: number;
  /** Only surface proposals with impact >= this (1-5; 1 = no floor). */
  minImpact: number;
  /** Only surface proposals with effort <= this (1-5; 5 = no ceiling). */
  maxEffort: number;
  /** Free-text focus topics to steer the plan toward (<= MAX_PLANNING_TOPICS). */
  topics: string[];
  /** Agent (`.claude/agents/` name) filling the PE role; null = unassigned (passes refuse to run). */
  peAgent: string | null;
  /** Agent name filling the PM role; null = unassigned (passes refuse to run). */
  pmAgent: string | null;
  /** Agent name that maintains the repo's product brief; null = none (product-map bootstrap disabled). */
  briefAgent: string | null;
  /** Model planning sessions run on (falls back to Opus when its quota is hit). */
  planningModel: string;
}

/** Last product-map bootstrap run for a repo (persisted in planning.json). */
export interface ProductMapRun {
  status: 'running' | 'done' | 'failed';
  finishedAt?: string;
  error?: string;
}

interface PlanningStore extends PlanningConfig {
  passes: PlanningPass[];
  /** Ad-hoc planning chat — the developer's direction for the next ad-hoc pass. */
  steering: DiscussionMessage[];
  /** Last product-map bootstrap run, if any. */
  productMapRun?: ProductMapRun;
}

/** Keep the ad-hoc planning transcript bounded so it can't grow the prompt without limit. */
const MAX_STEERING_MESSAGES = 40;

function sanitizeSteering(value: unknown): DiscussionMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (m): m is DiscussionMessage =>
        !!m &&
        typeof m === 'object' &&
        ((m as DiscussionMessage).role === 'user' ||
          (m as DiscussionMessage).role === 'assistant') &&
        typeof (m as DiscussionMessage).text === 'string'
    )
    .slice(-MAX_STEERING_MESSAGES);
}

/** Planning runs on Fable by default; when the configured model's usage limit is hit, fall back to Opus. */
const DEFAULT_PLANNING_MODEL = 'claude-fable-5';
const PLANNING_FALLBACK_MODEL = 'claude-opus-5';

/** Config defaults — automation off, mid impact/effort thresholds, no topic focus. */
const CONFIG_DEFAULTS: PlanningConfig = {
  intervalHours: null,
  roles: ['engineer', 'pm'],
  autoFile: false,
  maxAutoFile: 3,
  maxProposals: 9,
  minImpact: 3,
  maxEffort: 3,
  topics: [],
  peAgent: null,
  pmAgent: null,
  briefAgent: null,
  planningModel: DEFAULT_PLANNING_MODEL,
};

/** Trim an agent-name assignment; empty -> null. Existence is checked at pass start. */
function sanitizeAgentName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 100);
  return trimmed || null;
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;

/** Keep only valid, de-duplicated roles; fall back to both if none survive. */
function sanitizeRoles(value: unknown): PlanningRole[] {
  if (!Array.isArray(value)) return [...CONFIG_DEFAULTS.roles];
  const roles = [...new Set(value)].filter(
    (r): r is PlanningRole => r === 'engineer' || r === 'pm'
  );
  return roles.length > 0 ? roles : [...CONFIG_DEFAULTS.roles];
}

/** Trim, drop blanks, de-dupe, and cap the topic list. */
function sanitizeTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, 60);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    topics.push(trimmed);
    if (topics.length >= MAX_PLANNING_TOPICS) break;
  }
  return topics;
}

async function loadStore(repoPath: string): Promise<PlanningStore> {
  try {
    const raw = await fsp.readFile(planningFile(repoPath), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PlanningConfig> & {
      /** Legacy single master toggle — migrated to autoFile (autoStart now lives in execution config). */
      autonomous?: boolean;
      passes?: PlanningPass[];
      steering?: unknown;
      productMapRun?: ProductMapRun;
    };
    const legacyAutonomous = parsed.autonomous ?? false;
    return {
      intervalHours: parsed.intervalHours ?? null,
      roles: sanitizeRoles(parsed.roles),
      autoFile: parsed.autoFile ?? legacyAutonomous,
      maxAutoFile: clampInt(parsed.maxAutoFile, 0, 9, CONFIG_DEFAULTS.maxAutoFile),
      maxProposals: clampInt(parsed.maxProposals, 1, 20, CONFIG_DEFAULTS.maxProposals),
      minImpact: clampInt(parsed.minImpact, 1, 5, CONFIG_DEFAULTS.minImpact),
      maxEffort: clampInt(parsed.maxEffort, 1, 5, CONFIG_DEFAULTS.maxEffort),
      topics: sanitizeTopics(parsed.topics),
      peAgent: sanitizeAgentName(parsed.peAgent),
      pmAgent: sanitizeAgentName(parsed.pmAgent),
      briefAgent: sanitizeAgentName(parsed.briefAgent),
      // A retired model id in the store falls back to the default silently.
      planningModel: isKnownModel(parsed.planningModel)
        ? parsed.planningModel
        : DEFAULT_PLANNING_MODEL,
      passes: parsed.passes ?? [],
      steering: sanitizeSteering(parsed.steering),
      ...(parsed.productMapRun ? { productMapRun: parsed.productMapRun } : {}),
    };
  } catch {
    return { ...CONFIG_DEFAULTS, passes: [], steering: [] };
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
      // auto: true lets a scheduled pass auto-file proposals in autonomous mode.
      startPlanningPass(repo, { auto: true }).catch(() => {});
    }, hours * 3_600_000);
  }
}

// ---------------------------------------------------------------------------
// Planning config (independent knobs; read by the loop for auto-start)
// ---------------------------------------------------------------------------

/** Per-repo planning config, with defaults filled in. */
export async function getPlanningConfig(repo: RepoInfo): Promise<PlanningConfig> {
  const {
    passes: _passes,
    steering: _steering,
    productMapRun: _productMapRun,
    ...config
  } = await loadStore(repo.path);
  void _passes;
  void _steering;
  void _productMapRun;
  return config;
}

/** Patch planning config; values are validated/clamped and the scheduler re-armed. */
export async function setPlanningConfig(
  repo: RepoInfo,
  patch: Partial<PlanningConfig>
): Promise<void> {
  const store = await loadStore(repo.path);
  const intervalChanged =
    patch.intervalHours !== undefined && patch.intervalHours !== store.intervalHours;

  if (patch.intervalHours !== undefined) store.intervalHours = patch.intervalHours;
  if (patch.roles !== undefined) store.roles = sanitizeRoles(patch.roles);
  if (patch.autoFile !== undefined) store.autoFile = patch.autoFile;
  if (patch.maxAutoFile !== undefined)
    store.maxAutoFile = clampInt(patch.maxAutoFile, 0, 9, store.maxAutoFile);
  if (patch.maxProposals !== undefined)
    store.maxProposals = clampInt(patch.maxProposals, 1, 20, store.maxProposals);
  if (patch.minImpact !== undefined) store.minImpact = clampInt(patch.minImpact, 1, 5, store.minImpact);
  if (patch.maxEffort !== undefined) store.maxEffort = clampInt(patch.maxEffort, 1, 5, store.maxEffort);
  if (patch.topics !== undefined) store.topics = sanitizeTopics(patch.topics);
  if (patch.peAgent !== undefined) store.peAgent = sanitizeAgentName(patch.peAgent);
  if (patch.pmAgent !== undefined) store.pmAgent = sanitizeAgentName(patch.pmAgent);
  if (patch.briefAgent !== undefined) store.briefAgent = sanitizeAgentName(patch.briefAgent);
  if (patch.planningModel !== undefined)
    store.planningModel = isKnownModel(patch.planningModel)
      ? patch.planningModel
      : DEFAULT_PLANNING_MODEL;

  await saveStore(repo.path, store);
  if (intervalChanged) await ensurePlanningScheduler(repo);
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

function isUsageLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /limit|quota|overloaded|exhausted|insufficient|credit/i.test(message);
}

/** A single captured activity line, role-tagged later by the caller. */
type LogEvent = { kind: PlanningLogLine['kind']; text: string };

/** Run one query on the configured planning model, retrying once on Opus if limited. */
async function runPlanningQuery(
  repoPath: string,
  prompt: string,
  extras?: Parameters<typeof runQuery>[3],
  onEvent?: (event: LogEvent) => void
): Promise<string> {
  const { planningModel } = await loadStore(repoPath);
  try {
    return await runQuery(repoPath, prompt, planningModel, extras, onEvent);
  } catch (err) {
    if (!isUsageLimitError(err)) throw err;
    console.warn(
      `[orchestrator] planning: ${planningModel} limited, falling back to ${PLANNING_FALLBACK_MODEL}`
    );
    return runQuery(repoPath, prompt, PLANNING_FALLBACK_MODEL, extras, onEvent);
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
    abortController?: AbortController;
  },
  onEvent?: (event: LogEvent) => void
): Promise<string> {
  const q = query({
    prompt,
    options: {
      cwd: repoPath,
      model,
      permissionMode: 'default',
      canUseTool: readOnlyCanUseTool,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Repo rules only — never the developer's user-level settings.
      settingSources: ['project'],
      persistSession: false,
      ...(extras?.mcpServers ? { mcpServers: extras.mcpServers } : {}),
      ...(extras?.allowedTools ? { allowedTools: extras.allowedTools } : {}),
      ...(extras?.abortController ? { abortController: extras.abortController } : {}),
    },
  });
  let result = '';
  for await (const message of q) {
    if (onEvent && message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          onEvent({ kind: 'text', text: block.text.trim() });
        } else if (block.type === 'tool_use') {
          const input =
            block.input && typeof block.input === 'object'
              ? JSON.stringify(block.input)
              : String(block.input ?? '');
          onEvent({ kind: 'tool', text: `${block.name} ${input}`.trim() });
        }
      }
    }
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
  exclusions: string,
  shaping: ProposalShaping,
  planningMemory: string,
  adHocDirection: string,
  template: string,
  onEvent?: (event: LogEvent) => void,
  abortController?: AbortController
): Promise<string> {
  const definition = await fsp.readFile(defFile, 'utf8');
  const body = definition.replace(/^---[\s\S]*?---\s*/, '');
  return runPlanningQuery(
    repoPath,
    planningAgentPrompt(body, exclusions, shaping, planningMemory, adHocDirection, template),
    abortController ? { abortController } : undefined,
    onEvent
  );
}

/**
 * Resolve the persona definition file for a role. There are NO built-in
 * defaults: the role's agent must be assigned in config (Settings → Agents),
 * looked up by its `.claude/agents/` name via listRepoAgents (only agents
 * declaring a frontmatter `name` are eligible). Returns the absolute path and
 * a human label for error messages; throws when the role is unassigned.
 */
async function resolvePersonaFile(
  repo: RepoInfo,
  role: PlanningRole,
  config: PlanningConfig
): Promise<{ path: string | null; label: string }> {
  const assigned = role === 'engineer' ? config.peAgent : config.pmAgent;
  if (!assigned) {
    throw new Error(
      'Assign the PE and PM planning agents in Settings → Agents before running a pass'
    );
  }
  const agent = (await listRepoAgents(repo.path)).find(
    (a) => a.name.toLowerCase() === assigned.toLowerCase()
  );
  return {
    path: agent ? path.join(repo.path, '.claude', 'agents', agent.file) : null,
    label: `agent "${assigned}"`,
  };
}

/**
 * Resolve + validate the persona files for the requested roles before a pass
 * can run. Throws when a role has no assigned agent, and names any assigned
 * agents that no longer exist in the repo (surfaced on the Planning page).
 */
async function requirePersonaFiles(
  repo: RepoInfo,
  roles: PlanningRole[],
  config: PlanningConfig
): Promise<Record<PlanningRole, string>> {
  const paths = {} as Record<PlanningRole, string>;
  const missing: string[] = [];
  for (const role of roles) {
    const { path: p, label } = await resolvePersonaFile(repo, role, config);
    if (p === null) {
      missing.push(label);
      continue;
    }
    paths[role] = p;
    try {
      await fsp.access(p);
    } catch {
      missing.push(label);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Planning personas missing in ${repo.name}: ${missing.join(' and ')}`);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Synthesis (prompt in ./prompts/planning-synthesis)
// ---------------------------------------------------------------------------

interface RawProposal {
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  source?: unknown;
  effort?: unknown;
  impact?: unknown;
}

/** Legacy S/M/L and high/medium grades, mapped onto the 1-5 scale. */
const GRADE_ALIASES: Record<string, number> = {
  xs: 1, s: 2, small: 2, m: 3, med: 3, medium: 3, l: 4, large: 4, xl: 5,
  low: 2, high: 5, critical: 5,
};

/** Coerce an effort/impact value (number, "1-5", or legacy word) to a "1"-"5" string. */
function normalizeGrade(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.max(1, Math.min(5, Math.round(value))));
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return String(Math.max(1, Math.min(5, Math.round(numeric))));
  const alias = GRADE_ALIASES[trimmed.toLowerCase()];
  return alias ? String(alias) : undefined;
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
      effort: normalizeGrade(item.effort),
      impact: normalizeGrade(item.impact),
      status: 'pending' as const,
    }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Kick off a planning pass for a repo (engineer + PM in parallel, then synthesis).
 * `auto` marks a scheduler-triggered pass: on completion, if the repo is in
 * autonomous mode, its top-ranked proposals are auto-filed as issues.
 * `adHoc` marks a developer-driven ad-hoc pass: ONLY those inject the ad-hoc
 * planning chat transcript — scheduled/auto and plain manual passes run unsteered.
 */
export async function startPlanningPass(
  repo: RepoInfo,
  options: { auto?: boolean; roles?: PlanningRole[]; adHoc?: boolean } = {}
): Promise<string> {
  const g = planningState(repo.id);
  if (g.running) throw new Error('A planning pass is already running');
  const store = await loadStore(repo.path);
  // Manual runs pass an explicit scope; scheduled/auto runs use the config roles.
  const roles: PlanningRole[] =
    options.roles && options.roles.length > 0 ? options.roles : store.roles;
  const shaping: ProposalShaping = {
    topics: store.topics,
    minImpact: store.minImpact,
    maxEffort: store.maxEffort,
    maxProposals: store.maxProposals,
  };
  const personas = await requirePersonaFiles(repo, roles, store);
  // Prioritization guidance the personas learn from (dismiss reasons + hand edits).
  const { planningMemory } = await readSettings(repo.path);
  // The developer's ad-hoc planning chat — injected ONLY into ad-hoc passes.
  const adHocDirection = options.adHoc ? adHocDirectionBlock(store.steering) : '';
  // Admin-editable templates (Settings → Prompts) for the persona and synthesis prompts.
  const [agentTemplate, synthesisTemplate] = await Promise.all([
    readPromptTemplate('agents-planning'),
    readPromptTemplate('synthesis'),
  ]);
  g.running = true;
  g.cancelled = false;
  const abort = new AbortController();
  g.abort = abort;

  const pass: PlanningPass = {
    id: `pass-${Date.now()}`,
    startedAt: new Date().toISOString(),
    status: 'running',
    roles,
    proposals: [],
  };
  // Digest of prior proposals (before this pass) so agents skip re-proposing them.
  const exclusions = exclusionDigest(store.passes);
  store.passes.unshift(pass);
  await saveStore(repo.path, store);

  void (async () => {
    // Collect live agent activity so the pass log stays viewable after it ends.
    // Flushed on a single timer (never concurrently) to avoid store write races.
    const logs: PlanningLogLine[] = [];
    const record =
      (role: PlanningLogLine['role']) =>
      (event: LogEvent): void => {
        logs.push({ role, kind: event.kind, text: event.text.slice(0, 2000) });
      };
    // Flushes are chained (never overlapping writes) and stop once `done` is set,
    // so a lagging flush can't clobber the authoritative final status write below.
    let done = false;
    let flushing: Promise<void> = Promise.resolve();
    const flush = setInterval(() => {
      if (done) return;
      flushing = flushing.then(() =>
        updatePass(repo.path, pass.id, (p) => {
          p.logs = logs.slice();
        }).catch(() => {})
      );
    }, 4000);
    const stopFlushing = async () => {
      done = true;
      clearInterval(flush);
      await flushing;
    };

    try {
      // Run only the selected agents; the unselected report stays empty and
      // synthesis formats whichever report(s) are present.
      const reports: Record<PlanningRole, string> = { engineer: '', pm: '' };
      await Promise.all(
        roles.map(async (role) => {
          reports[role] = await runPlanningAgent(
            repo.path,
            personas[role],
            exclusions,
            shaping,
            planningMemory,
            adHocDirection,
            agentTemplate,
            record(role),
            abort
          );
        })
      );
      const proposals = parseProposals(
        await runPlanningQuery(
          repo.path,
          synthesisPrompt(
            reports.engineer,
            reports.pm,
            exclusions,
            shaping,
            planningMemory,
            adHocDirection,
            synthesisTemplate
          ),
          { abortController: abort },
          record('synthesis')
        )
      );
      await stopFlushing();
      await updatePass(repo.path, pass.id, (p) => {
        p.status = 'complete';
        p.proposals = proposals;
        p.logs = logs.slice();
      });
      if (options.auto) {
        await autoFileTopProposals(repo, pass.id).catch((err) =>
          console.error(
            `[orchestrator] planning: auto-file failed for ${repo.name}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );
      }
    } catch (err) {
      await stopFlushing();
      const message = g.cancelled
        ? 'Cancelled by the developer'
        : err instanceof Error
          ? err.message
          : String(err);
      await updatePass(repo.path, pass.id, (p) => {
        p.status = 'failed';
        p.error = message;
        p.logs = logs.slice();
      }).catch(() => {});
    } finally {
      g.running = false;
      g.abort = null;
    }
  })();

  return pass.id;
}

/**
 * Cancel the in-flight planning pass for a repo: abort its agent queries and
 * let the running task mark the pass failed ("Cancelled by the developer").
 * No-op error if nothing is running.
 */
export function cancelPlanningPass(repo: RepoInfo): void {
  const g = planningState(repo.id);
  if (!g.running || !g.abort) throw new Error('No planning pass is running');
  g.cancelled = true;
  g.abort.abort();
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

/**
 * Auto-file the top-N pending proposals of a just-completed pass as issues
 * (ranked order — synthesis already sorts by leverage). Reuses the same
 * `fileProposals` path (label `proposed`), and future passes' exclusion digest
 * skips already-filed titles, so this cannot re-file the same work each run.
 */
async function autoFileTopProposals(repo: RepoInfo, passId: string): Promise<void> {
  const { autoFile, maxAutoFile } = await getPlanningConfig(repo);
  if (!autoFile || maxAutoFile <= 0) return;
  const store = await loadStore(repo.path);
  const pass = store.passes.find((p) => p.id === passId);
  if (!pass) return;
  const ids = pass.proposals
    .filter((p) => p.status === 'pending')
    .slice(0, maxAutoFile)
    .map((p) => p.id);
  if (ids.length === 0) return;
  await fileProposals(repo, passId, ids);
}

/** Dismiss the selected pending proposals. */
export async function dismissProposals(
  repo: RepoInfo,
  passId: string,
  proposalIds: string[],
  reason?: string
): Promise<void> {
  const dismissedTitles: string[] = [];
  await updatePass(repo.path, passId, (pass) => {
    for (const id of proposalIds) {
      const proposal = pass.proposals.find((p) => p.id === id);
      if (proposal && proposal.status === 'pending') {
        proposal.status = 'dismissed';
        dismissedTitles.push(proposal.title);
      }
    }
  });
  // A reason is prioritization signal — record it so future passes learn from it.
  const note = reason?.trim();
  if (note && dismissedTitles.length > 0) {
    await appendPlanningMemory(
      repo.path,
      `Rejected "${dismissedTitles.join('", "')}": ${note}`
    );
  }
}

// ---------------------------------------------------------------------------
// Ad-hoc planning chat (the pass-level chat on the planning page)
//
// A cheap conversational turn that shapes WHAT the next ad-hoc pass looks for.
// It never writes proposals — those come only from a regenerated pass started
// with adHoc: true, which injects this transcript into the PE/PM and synthesis
// prompts.
// ---------------------------------------------------------------------------

/** The stored ad-hoc planning transcript for a repo. */
export async function getPlanningSteering(repo: RepoInfo): Promise<DiscussionMessage[]> {
  return (await loadStore(repo.path)).steering;
}

/** Replace the ad-hoc planning transcript (used to clear it). */
export async function setPlanningSteering(
  repo: RepoInfo,
  messages: DiscussionMessage[]
): Promise<DiscussionMessage[]> {
  const store = await loadStore(repo.path);
  store.steering = sanitizeSteering(messages);
  await saveStore(repo.path, store);
  return store.steering;
}

/**
 * One ad-hoc planning chat turn: append the developer's message, get a reply,
 * persist both. Returns the full transcript so the client stays in sync.
 */
export async function sendPlanningSteering(
  repo: RepoInfo,
  text: string
): Promise<DiscussionMessage[]> {
  const store = await loadStore(repo.path);
  const { goal } = await readSettings(repo.path);
  // Titles of what's already on the board, so it doesn't re-suggest them.
  const currentProposals = store.passes[0]?.proposals.map((p) => p.title) ?? [];

  const next: DiscussionMessage[] = [...store.steering, { role: 'user', text }];
  const reply = await runPlanningQuery(
    repo.path,
    adHocChatPrompt(goal, currentProposals, next, await readPromptTemplate('adhoc-chat'))
  );
  return setPlanningSteering(repo, [...next, { role: 'assistant', text: reply }]);
}

// ---------------------------------------------------------------------------
// Product-map bootstrap state (the run itself lives in ./product-map.ts)
// ---------------------------------------------------------------------------

/** Last product-map bootstrap run, or null if never run. */
export async function getProductMapState(repo: RepoInfo): Promise<ProductMapRun | null> {
  return (await loadStore(repo.path)).productMapRun ?? null;
}

/** Persist the product-map bootstrap run state (called by the runner). */
export async function setProductMapRun(repoPath: string, run: ProductMapRun): Promise<void> {
  const store = await loadStore(repoPath);
  store.productMapRun = run;
  await saveStore(repoPath, store);
}

// ---------------------------------------------------------------------------
// Proposal discussion (the "Discuss" drawer on the planning page).
// Prompt + DiscussionMessage type live in ./prompts/proposal-discussion.
// ---------------------------------------------------------------------------

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
        UPDATE_PROPOSAL_TOOL_DESCRIPTION,
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
        CREATE_PROPOSAL_TOOL_DESCRIPTION,
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

  const reply = await runPlanningQuery(
    repo.path,
    discussionPrompt(proposal, goal, messages, await readPromptTemplate('proposal-discussion')),
    {
      mcpServers: { orchestrator: tools },
      allowedTools: ['mcp__orchestrator__update_proposal', 'mcp__orchestrator__create_proposal'],
    }
  );

  // Persist the full transcript (incoming turns + this reply) onto the proposal
  // so it survives refresh/navigation. updatePass reloads the store, so this is
  // safe against any proposal edits the tools applied mid-turn.
  await updatePass(repo.path, passId, (p) => {
    const target = p.proposals.find((x) => x.id === proposalId);
    if (target) target.discussion = [...messages, { role: 'assistant', text: reply }];
  });

  return reply;
}

/** Clear a proposal's persisted discussion transcript. */
export async function clearProposalDiscussion(
  repo: RepoInfo,
  passId: string,
  proposalId: string
): Promise<void> {
  await updatePass(repo.path, passId, (pass) => {
    const target = pass.proposals.find((p) => p.id === proposalId);
    if (target) target.discussion = [];
  });
}
