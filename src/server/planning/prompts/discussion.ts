/**
 * CASE: Proposal discussion — the "Discuss with Claude Code" drawer on the
 * planning page. `discussionPrompt` drives one chat turn about ONE proposal
 * before it may be filed (static wording in DEFAULT_PROPOSAL_DISCUSSION_TEMPLATE,
 * admin-overridable via Settings → Prompts), and the two tool descriptions are
 * the model-facing text for the `update_proposal` / `create_proposal` MCP tools
 * that turn exposes.
 */

import type { DiscussionMessage, PlanningProposal } from '@/lib/types';
import { renderTemplate } from '@/server/core/render';

// Re-exported so existing importers (prompts/index, server/planning) keep working.
export type { DiscussionMessage };

export const DEFAULT_PROPOSAL_DISCUSSION_TEMPLATE = `You are discussing ONE task proposal with the developer before it may be
filed as a GitHub issue. Your working directory is the repository the
proposal is about — read code (read-only) to verify claims when the
discussion needs evidence. Agree or push back on the merits, not to please.

BE BRIEF AND SCANNABLE. This is a chat, not a document. Aim for ~2-5 short
sentences; only go longer when the developer explicitly asks you to expand.
Lead with a one-line answer first, then the supporting detail.
Formatting for readability:
- Prefer short bullet points ("- ...") over dense paragraphs whenever you
  list more than one thing (options, steps, findings, trade-offs).
- Use a few tasteful emoji as visual anchors — e.g. ✅ agree / good,
  ⚠️ caveat or risk, 🔧 code change, 💡 suggestion, ❓ open question. One per
  line at most; never decorate every word.
- Put file/symbol references in \`backticks\`. Bold the key phrase of a bullet
  when it helps scanning, but keep it light.
No preamble or recap, and cut filler ("Great question", "In summary").

Tools:
- \`update_proposal\` — apply changes the two of you agree on (partial:
  title/body/labels). Keep bodies in "## Problem / ## Proposed direction /
  ## Success criteria / ## Technical details" form. Problem, Proposed
  direction, and Success criteria stay plain language with NO code refs
  (bullets/numbers); ALL code anchors live in Technical details at the
  bottom. Labels only from: Bug, FE, BE, AI, Infra.
- \`create_proposal\` — when you agree to split scope, create the new
  proposal in the same pass (same body format).
After a tool call, confirm in one sentence what changed. Never create
GitHub issues — the developer files proposals from the UI.

## Project goal
{{goal}}

## Current proposal
{{proposal}}

{{#transcript}}
## Conversation so far
{{transcript}}
{{/transcript}}

Reply to the last developer message.`;

export function discussionPrompt(
  proposal: PlanningProposal,
  goal: string,
  messages: DiscussionMessage[],
  template?: string
): string {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'DEVELOPER' : 'YOU'}: ${m.text}`)
    .join('\n\n');
  return renderTemplate(template ?? DEFAULT_PROPOSAL_DISCUSSION_TEMPLATE, {
    goal: goal.trim() || '(no goal file)',
    proposal: JSON.stringify(proposal, null, 2),
    transcript,
  });
}

/** `update_proposal` MCP tool — apply agreed partial edits to the proposal. */
export const UPDATE_PROPOSAL_TOOL_DESCRIPTION =
  'Apply agreed changes to the proposal under discussion. Provide only the fields to change.';

/** `create_proposal` MCP tool — add another proposal to the same pass (split scope). */
export const CREATE_PROPOSAL_TOOL_DESCRIPTION =
  'Create an additional proposal in the same planning pass (e.g. when splitting scope).';
