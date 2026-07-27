import * as fsp from 'node:fs/promises';
import type {
  PlanningLogLine,
  RefinementPass,
  RefinementTarget,
  RefinementVerdict,
  RepoInfo,
} from '@/lib/types';
import { closeIssue, editIssue, listOpenIssues } from '@/server/core/github';
import { readPromptTemplate } from '@/server/knowledge/prompt-templates';
import { appendPlanningMemory, readSettings } from '@/server/knowledge/settings';
import {
  addRefinementPass,
  dismissProposals,
  getPlanning,
  getPlanningConfig,
  getRefinementPasses,
  type LogEvent,
  type PlanningRole,
  requirePersonaFiles,
  runPlanningQuery,
  updateProposalContent,
  updateRefinementPass,
} from '@/server/planning/planning';
import {
  refinementAgentPrompt,
  type RefinementItem,
  refinementSynthesisPrompt,
} from '@/server/planning/prompts';

/**
 * Refinement passes: re-examine the open backlog — pending proposals plus
 * filed-but-untouched `proposed` issues — against the current state of the
 * code and the goal. The same PE and PM agents that run planning passes each
 * judge every item read-only in parallel, and a synthesis step merges their
 * reports into final verdicts (conservative on disagreement). The pass only
 * RECOMMENDS: every verdict (drop, rewrite, overlap) waits for the developer
 * to apply or reject it on the Planning page. Run on demand or on its own
 * interval.
 */

const REFINEMENT_ROLES: readonly PlanningRole[] = ['engineer', 'pm'];

interface RepoRefinementState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  armedHours: number | null;
  abort: AbortController | null;
  cancelled: boolean;
}

const globalRef = globalThis as typeof globalThis & {
  __orchestratorRefinement?: { repos: Map<string, RepoRefinementState> };
};

function refinementState(repoId: string): RepoRefinementState {
  globalRef.__orchestratorRefinement ??= { repos: new Map() };
  const { repos } = globalRef.__orchestratorRefinement;
  let s = repos.get(repoId);
  if (!s) {
    s = { running: false, timer: null, armedHours: null, abort: null, cancelled: false };
    repos.set(repoId, s);
  }
  return s;
}

/** Arm/re-arm a repo's refinement auto-run timer to match its stored interval. Idempotent. */
export async function ensureRefinementScheduler(repo: RepoInfo): Promise<void> {
  const g = refinementState(repo.id);
  const { refinementIntervalHours } = await getPlanning(repo);
  const hours = refinementIntervalHours ?? null;
  if (g.armedHours === hours && (hours === null || g.timer !== null)) return;
  if (g.timer) {
    clearInterval(g.timer);
    g.timer = null;
  }
  g.armedHours = hours;
  if (hours !== null) {
    g.timer = setInterval(() => {
      // Throws when one is already running, or when there's nothing to refine — both skips are fine.
      startRefinementPass(repo).catch(() => {});
    }, hours * 3_600_000);
  }
}

// ---------------------------------------------------------------------------
// Target collection
// ---------------------------------------------------------------------------

/** One evaluated backlog item: the prompt digest entry plus how to act on its verdict. */
interface CollectedItem {
  item: RefinementItem;
  target: RefinementTarget;
}

/**
 * The backlog a pass evaluates: pending proposals from every stored planning
 * pass (deduped by title, newest pass wins) and open `proposed` GitHub issues
 * no agent has touched (no agent-* label).
 */
async function collectTargets(repo: RepoInfo): Promise<CollectedItem[]> {
  const { passes } = await getPlanning(repo);
  const collected: CollectedItem[] = [];
  const seenTitles = new Set<string>();

  for (const pass of passes) {
    for (const proposal of pass.proposals) {
      if (proposal.status !== 'pending') continue;
      const key = proposal.title.trim().toLowerCase();
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      collected.push({
        item: {
          ref: `proposal:${pass.id}:${proposal.id}`,
          title: proposal.title,
          body: proposal.body,
          labels: proposal.labels,
        },
        target: { kind: 'proposal', passId: pass.id, proposalId: proposal.id },
      });
    }
  }

  const issues = await listOpenIssues(repo.path);
  for (const issue of issues) {
    if (!issue.labels.includes('proposed')) continue;
    if (issue.labels.some((label) => label.startsWith('agent-'))) continue;
    collected.push({
      item: {
        ref: `issue:${issue.number}`,
        title: issue.title,
        body: issue.body,
        labels: issue.labels.filter((label) => label !== 'proposed'),
      },
      target: {
        kind: 'issue',
        issueNumber: issue.number,
        ...(repo.htmlUrl ? { issueUrl: `${repo.htmlUrl}/issues/${issue.number}` } : {}),
      },
    });
  }

  return collected;
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

interface RawVerdict {
  ref?: unknown;
  verdict?: unknown;
  reasoning?: unknown;
  rewrite?: { title?: unknown; body?: unknown };
  overlapsWith?: unknown;
}

function parseVerdicts(raw: string, targets: CollectedItem[]): RefinementVerdict[] {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('refinement returned no JSON array');
  const parsed = JSON.parse(text.slice(start, end + 1)) as RawVerdict[];

  const byRef = new Map(targets.map((t) => [t.item.ref, t]));
  const verdicts: RefinementVerdict[] = [];
  for (const entry of parsed) {
    if (typeof entry.ref !== 'string') continue;
    const target = byRef.get(entry.ref);
    if (!target) continue;
    byRef.delete(entry.ref); // one verdict per item — ignore duplicates
    if (entry.verdict !== 'keep' && entry.verdict !== 'drop') continue;
    const rewrite =
      entry.verdict === 'keep' &&
      entry.rewrite &&
      typeof entry.rewrite.title === 'string' &&
      typeof entry.rewrite.body === 'string'
        ? { title: entry.rewrite.title.slice(0, 120), body: entry.rewrite.body }
        : undefined;
    const overlapsWith = Array.isArray(entry.overlapsWith)
      ? entry.overlapsWith.filter((t): t is string => typeof t === 'string')
      : [];
    verdicts.push({
      id: `v${verdicts.length + 1}`,
      target: target.target,
      title: target.item.title,
      verdict: entry.verdict,
      reasoning: typeof entry.reasoning === 'string' ? entry.reasoning : '',
      ...(rewrite ? { rewrite } : {}),
      ...(overlapsWith.length > 0 ? { overlapsWith } : {}),
    });
  }
  if (verdicts.length === 0) throw new Error('refinement returned no usable verdicts');
  return verdicts;
}

// ---------------------------------------------------------------------------
// Pass lifecycle
// ---------------------------------------------------------------------------

/**
 * Kick off a refinement pass: the assigned PE and PM agents judge the backlog
 * in parallel, then synthesis merges their reports into verdicts. Throws when
 * one is already running, the personas are unassigned, or the backlog is empty.
 */
export async function startRefinementPass(repo: RepoInfo): Promise<string> {
  const g = refinementState(repo.id);
  if (g.running) throw new Error('A refinement pass is already running');
  // Claim the run slot before beginRefinementPass's awaits, so two rapid starts
  // can't both pass the guard; released again when pre-flight fails.
  g.running = true;
  g.cancelled = false;
  try {
    return await beginRefinementPass(repo, g);
  } catch (err) {
    g.running = false;
    g.abort = null;
    throw err;
  }
}

/** Pre-flight + launch, once the run slot is claimed (see startRefinementPass). */
async function beginRefinementPass(repo: RepoInfo, g: RepoRefinementState): Promise<string> {
  const config = await getPlanningConfig(repo);
  const personas = await requirePersonaFiles(repo, [...REFINEMENT_ROLES], config);

  const targets = await collectTargets(repo);
  if (targets.length === 0) {
    throw new Error('Nothing to refine — no pending proposals or open proposed issues');
  }
  const items = targets.map((t) => t.item);

  const { goal, planningMemory } = await readSettings(repo.path);
  const [agentTemplate, synthesisTemplate] = await Promise.all([
    readPromptTemplate('refinement'),
    readPromptTemplate('refinement-synthesis'),
  ]);

  const abort = new AbortController();
  g.abort = abort;

  const pass: RefinementPass = {
    id: `refine-${Date.now()}`,
    startedAt: new Date().toISOString(),
    status: 'running',
    verdicts: [],
  };
  await addRefinementPass(repo.path, pass);

  void (async () => {
    // Same chained-flush pattern as planning passes: live logs persist on a
    // timer, and the final status write always lands after the last flush.
    const logs: PlanningLogLine[] = [];
    const record =
      (role: PlanningLogLine['role']) =>
      (event: LogEvent): void => {
        logs.push({ role, kind: event.kind, text: event.text.slice(0, 2000) });
      };
    let done = false;
    let flushing: Promise<void> = Promise.resolve();
    const flush = setInterval(() => {
      if (done) return;
      flushing = flushing.then(() =>
        updateRefinementPass(repo.path, pass.id, (p) => {
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
      const reports: Record<PlanningRole, string> = { engineer: '', pm: '' };
      await Promise.all(
        REFINEMENT_ROLES.map(async (role) => {
          const definition = await fsp.readFile(personas[role], 'utf8');
          const personaBody = definition.replace(/^---[\s\S]*?---\s*/, '');
          reports[role] = await runPlanningQuery(
            repo.path,
            refinementAgentPrompt(personaBody, goal, planningMemory, items, agentTemplate),
            { abortController: abort },
            record(role)
          );
        })
      );
      const raw = await runPlanningQuery(
        repo.path,
        refinementSynthesisPrompt(reports.engineer, reports.pm, items, synthesisTemplate),
        { abortController: abort },
        record('refinement')
      );
      const verdicts = parseVerdicts(raw, targets);
      await stopFlushing();
      await updateRefinementPass(repo.path, pass.id, (p) => {
        p.status = 'complete';
        p.verdicts = verdicts;
        p.logs = logs.slice();
      });
    } catch (err) {
      await stopFlushing();
      const message = g.cancelled
        ? 'Cancelled by the developer'
        : err instanceof Error
          ? err.message
          : String(err);
      await updateRefinementPass(repo.path, pass.id, (p) => {
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

/** Abort the in-flight refinement pass. No-op error if nothing is running. */
export function cancelRefinementPass(repo: RepoInfo): void {
  const g = refinementState(repo.id);
  if (!g.running || !g.abort) throw new Error('No refinement pass is running');
  g.cancelled = true;
  g.abort.abort();
}

// ---------------------------------------------------------------------------
// Applying verdicts (the developer's click)
// ---------------------------------------------------------------------------

/**
 * Resolve one verdict. `reject` just records the decision; `apply` executes it:
 * - proposal drop → dismissed (reason fed into planning memory)
 * - issue drop → closed on GitHub with the reasoning as a comment, + memory
 * - keep with rewrite → the proposal / issue content is updated
 * - plain keep → nothing to execute, just recorded
 */
export async function resolveRefinementVerdict(
  repo: RepoInfo,
  passId: string,
  verdictId: string,
  action: 'apply' | 'reject'
): Promise<void> {
  const pass = (await getRefinementPasses(repo.path)).find((p) => p.id === passId);
  const verdict = pass?.verdicts.find((v) => v.id === verdictId);
  if (!pass || !verdict) throw new Error(`Unknown refinement verdict ${verdictId} in ${passId}`);
  if (verdict.resolution) throw new Error('Verdict already resolved');

  if (action === 'apply') {
    const { target } = verdict;
    // The backlog may have moved since the pass ran: a proposal the developer
    // filed or dismissed in the meantime must not be silently marked applied.
    if (target.kind === 'proposal') {
      const { passes } = await getPlanning(repo);
      const proposal = passes
        .find((p) => p.id === target.passId)
        ?.proposals.find((p) => p.id === target.proposalId);
      if (!proposal || proposal.status !== 'pending') {
        throw new Error(
          'This proposal is no longer pending (filed or dismissed since the pass ran) — ignore the verdict instead'
        );
      }
    }
    if (verdict.verdict === 'drop') {
      if (target.kind === 'proposal') {
        await dismissProposals(repo, target.passId, [target.proposalId], verdict.reasoning);
      } else {
        await closeIssue(
          repo.path,
          target.issueNumber,
          `Closed by a Hydra refinement pass (confirmed by the developer).\n\n${verdict.reasoning}`
        );
        await appendPlanningMemory(repo.path, `Rejected "${verdict.title}": ${verdict.reasoning}`);
      }
    } else if (verdict.rewrite) {
      if (target.kind === 'proposal') {
        await updateProposalContent(repo.path, target.passId, target.proposalId, verdict.rewrite);
      } else {
        await editIssue(repo.path, target.issueNumber, verdict.rewrite);
      }
    }
  }

  await updateRefinementPass(repo.path, passId, (p) => {
    const v = p.verdicts.find((x) => x.id === verdictId);
    if (v) v.resolution = action === 'apply' ? 'applied' : 'rejected';
  });
}
