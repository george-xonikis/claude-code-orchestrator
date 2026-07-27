import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { DEFAULT_CONFLICT_TEMPLATE } from '@/server/execution/prompts/conflict';
import { DEFAULT_IMPLEMENTATION_TEMPLATE } from '@/server/execution/prompts/implementation';
import {
  DEFAULT_ADHOC_CHAT_TEMPLATE,
  DEFAULT_AGENTS_PLANNING_TEMPLATE,
  DEFAULT_PRODUCT_MAP_TEMPLATE,
  DEFAULT_PROPOSAL_DISCUSSION_TEMPLATE,
  DEFAULT_REFINEMENT_SYNTHESIS_TEMPLATE,
  DEFAULT_REFINEMENT_TEMPLATE,
  DEFAULT_SYNTHESIS_TEMPLATE,
} from '@/server/planning/prompts';

/**
 * App-level prompt templates — the developer's full-control override for the
 * text Hydra launches agent sessions with.
 *
 * These are HYDRA's words, not a repo's: the prompt is only the session
 * envelope, and everything repo-specific already lives in each managed repo's
 * own CLAUDE.md / .claude/. So overrides are global, stored beside the repo
 * registry at <app-root>/data/prompts/<kind>.md (git-ignored, hand-editable),
 * and apply to sessions in every managed repo. When a file is absent or blank
 * the built-in default (execution/prompts/*, planning/prompts/*) is used.
 *
 * Template language (deliberately tiny):
 * - `{{name}}` — replaced with the variable's value ('' when absent).
 * - `{{#name}}…{{/name}}` — the enclosed block is kept only when the variable
 *   is non-empty (used for the memory section and the workflow hint).
 * - Runs of 3+ newlines collapse to one blank line after substitution.
 */

export type PromptKind =
  | 'implementation'
  | 'conflict'
  | 'agents-planning'
  | 'synthesis'
  | 'refinement'
  | 'refinement-synthesis'
  | 'adhoc-chat'
  | 'proposal-discussion'
  | 'product-map';

export const PROMPT_KINDS: readonly PromptKind[] = [
  'implementation',
  'conflict',
  'agents-planning',
  'synthesis',
  'refinement',
  'refinement-synthesis',
  'adhoc-chat',
  'proposal-discussion',
  'product-map',
];

export const DEFAULT_TEMPLATES: Record<PromptKind, string> = {
  implementation: DEFAULT_IMPLEMENTATION_TEMPLATE,
  conflict: DEFAULT_CONFLICT_TEMPLATE,
  'agents-planning': DEFAULT_AGENTS_PLANNING_TEMPLATE,
  synthesis: DEFAULT_SYNTHESIS_TEMPLATE,
  refinement: DEFAULT_REFINEMENT_TEMPLATE,
  'refinement-synthesis': DEFAULT_REFINEMENT_SYNTHESIS_TEMPLATE,
  'adhoc-chat': DEFAULT_ADHOC_CHAT_TEMPLATE,
  'proposal-discussion': DEFAULT_PROPOSAL_DISCUSSION_TEMPLATE,
  'product-map': DEFAULT_PRODUCT_MAP_TEMPLATE,
};

/** Placeholders each kind's renderer provides (shown as a reference in the editor UI). */
export const TEMPLATE_PLACEHOLDERS: Record<PromptKind, string[]> = {
  implementation: ['issueNumber', 'worktreePath', 'branch', 'workflowHint', 'productMap'],
  conflict: ['issueNumber', 'prNumber', 'worktreePath', 'branch', 'baseBranch', 'workflowHint'],
  'agents-planning': ['shaping', 'adHocDirection', 'planningMemory', 'exclusions', 'personaBody'],
  synthesis: [
    'maxProposals',
    'shapingConstraints',
    'adHocDirection',
    'planningMemory',
    'exclusions',
    'engineerReport',
    'pmReport',
  ],
  refinement: ['personaBody', 'goal', 'planningMemory', 'items'],
  'refinement-synthesis': ['engineerReport', 'pmReport', 'items'],
  'adhoc-chat': ['goal', 'currentProposals', 'transcript'],
  'proposal-discussion': ['goal', 'proposal', 'transcript'],
  'product-map': ['agentBody'],
};

const MAX_TEMPLATE_LENGTH = 50_000;

const PROMPTS_DIR = path.join(process.cwd(), 'data', 'prompts');

function templateFile(kind: PromptKind): string {
  return path.join(PROMPTS_DIR, `${kind}.md`);
}

/** One kind's stored state, as served by GET /api/prompts. */
export interface PromptTemplateState {
  /** The effective template (the override, or the built-in default). */
  template: string;
  /** True when an override file exists. */
  isCustom: boolean;
  /** The built-in default, so the UI can offer diff/reset. */
  defaultTemplate: string;
}

async function readOverride(kind: PromptKind): Promise<string | null> {
  try {
    const raw = await fsp.readFile(templateFile(kind), 'utf8');
    return raw.trim() ? raw : null; // a blank file counts as "no override"
  } catch {
    return null;
  }
}

/** The effective template for one kind (override if present, else the default). */
export async function readPromptTemplate(kind: PromptKind): Promise<string> {
  return (await readOverride(kind)) ?? DEFAULT_TEMPLATES[kind];
}

/** All kinds' stored state (backs GET /api/prompts). */
export async function readPromptTemplates(): Promise<Record<PromptKind, PromptTemplateState>> {
  const states = await Promise.all(
    PROMPT_KINDS.map(async (kind) => {
      const override = await readOverride(kind);
      return [
        kind,
        {
          template: override ?? DEFAULT_TEMPLATES[kind],
          isCustom: override !== null,
          defaultTemplate: DEFAULT_TEMPLATES[kind],
        },
      ] as const;
    })
  );
  return Object.fromEntries(states) as Record<PromptKind, PromptTemplateState>;
}

/**
 * Save one kind's override (atomic write), or reset to the default by passing
 * null / blank — the override file is removed so future default improvements
 * apply again.
 */
export async function writePromptTemplate(
  kind: PromptKind,
  template: string | null
): Promise<void> {
  const file = templateFile(kind);
  if (template === null || !template.trim()) {
    await fsp.rm(file, { force: true });
    return;
  }
  if (template.length > MAX_TEMPLATE_LENGTH) {
    throw new Error(`Template too long (max ${MAX_TEMPLATE_LENGTH} characters)`);
  }
  await fsp.mkdir(PROMPTS_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, template, 'utf8');
  await fsp.rename(tmp, file);
}

export { renderTemplate } from '@/server/core/render';
