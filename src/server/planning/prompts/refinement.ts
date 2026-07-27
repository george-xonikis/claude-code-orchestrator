/**
 * CASE: Refinement pass — the repo's assigned PE and PM planning agents each
 * re-examine the existing backlog (pending proposals and filed-but-untouched
 * `proposed` issues) against the CURRENT state of the code and the goal, and a
 * synthesis step merges their two judgement reports into final keep/drop
 * verdicts with reasoning, optional rewrites, and overlap flags. The pass
 * recommends only — the developer applies each verdict from the Planning page.
 *
 * The static wording lives in DEFAULT_REFINEMENT_TEMPLATE (the persona
 * wrapper) and DEFAULT_REFINEMENT_SYNTHESIS_TEMPLATE, both admin-overridable
 * via Settings → Prompts; the builders pre-render the persona, goal, planning
 * memory, and items digest into string vars.
 */

import { renderTemplate } from '@/server/core/render';

/** One backlog item handed to the refinement agents for judgement. */
export interface RefinementItem {
  /** Stable reference the verdict must echo back ("proposal:<passId>:<id>" or "issue:<n>"). */
  ref: string;
  title: string;
  body: string;
  labels: string[];
}

/** Cap per-item body length so a large backlog can't blow up the prompt. */
const MAX_ITEM_BODY = 4000;

function itemsDigest(items: RefinementItem[]): string {
  return JSON.stringify(
    items.map((item) => ({
      ref: item.ref,
      title: item.title,
      labels: item.labels,
      body: item.body.length > MAX_ITEM_BODY ? `${item.body.slice(0, MAX_ITEM_BODY)}\n…(truncated)` : item.body,
    })),
    null,
    2
  );
}

/** Compact ref+title index for the synthesis step (the reports carry the detail). */
function itemsIndex(items: RefinementItem[]): string {
  return JSON.stringify(
    items.map((item) => ({ ref: item.ref, title: item.title })),
    null,
    2
  );
}

export const DEFAULT_REFINEMENT_TEMPLATE = `You are refining the task backlog of this repository, judging from the
persona defined below.

=== PERSONA ===
{{personaBody}}
=== END PERSONA ===

Below is every open backlog item: planning proposals awaiting a decision, and
GitHub issues that were filed from proposals but that no agent has started
working on.

The backlog was written in the past — the code has moved since. Your job is to
judge each item against the repository AS IT IS NOW and recommend what to do
with it. You may inspect the code freely (read-only). For each item, verify
its claims before judging: an item is obsolete when the work it describes is
already implemented, no longer applies to the current architecture, or no
longer serves the goal.

{{#goal}}
PROJECT GOAL AND CURRENT PRIORITIES:
{{goal}}
{{/goal}}
{{#planningMemory}}
PRIORITIZATION GUIDANCE (developer-maintained — items it argues against should lean "drop"):
{{planningMemory}}
{{/planningMemory}}

For every item decide:
- "keep" — still valid and worth doing as written.
- "keep" WITH a rewrite — the underlying need is real but the item is stale:
  partially implemented, wrong about the current code, or poorly scoped.
  Provide an updated title/body describing only the work that is actually left,
  keeping the original body's section structure.
- "drop" — obsolete, already implemented, or no longer serving the goal.
  Make the reasoning concrete: cite what you found in the code.

Also compare the items with EACH OTHER: when two items describe the same
underlying work (or one subsumes the other), keep the stronger one and drop
the weaker, listing the counterpart's title under overlaps on both.

Judge conservatively — a drop recommendation deletes real backlog once
confirmed. When you cannot verify an item's claims either way, keep it and say
so in the reasoning.

BACKLOG ITEMS (JSON):
{{items}}

Report on EVERY item, one section each, exactly in this shape:
### <ref>
verdict: keep | drop
reasoning: 1-3 sentences grounded in what you verified
rewrite: (only when suggesting one) the updated title on one line, then the updated body
overlaps: (only when overlapping) the overlapping items' titles, comma-separated`;

export function refinementAgentPrompt(
  personaBody: string,
  goal: string,
  planningMemory: string,
  items: RefinementItem[],
  template?: string
): string {
  return renderTemplate(template ?? DEFAULT_REFINEMENT_TEMPLATE, {
    personaBody: personaBody.trim(),
    goal: goal.trim(),
    planningMemory: planningMemory.trim(),
    items: itemsDigest(items),
  });
}

export const DEFAULT_REFINEMENT_SYNTHESIS_TEMPLATE = `You are the synthesis step of a backlog refinement pass. A Principal
Engineer and a Product Manager have each independently judged every open
backlog item against the current state of the code; their reports are below.
Merge them into ONE final verdict per item:
- Both say drop → drop, with the merged reasoning.
- They disagree → keep (the conservative default) and note the disagreement in
  the reasoning — UNLESS one report cites concrete verified evidence the other
  missed (e.g. the work is demonstrably already implemented); then follow the
  evidence.
- Merge rewrite suggestions into one: the PM's problem/outcome framing with the
  engineer's code anchors, scoped to only the work that is actually left.
- Overlaps are the union of what both reports flagged.

Respond with STRICT JSON ONLY (no prose, no code fences): an array with EXACTLY
one object per backlog item, each with keys:
- ref (string — echo the item's ref unchanged)
- verdict ("keep" | "drop")
- reasoning (string, 1-3 sentences grounded in what the reports verified)
- rewrite (optional — only on "keep": { title, body } with the updated content)
- overlapsWith (optional — array of the overlapping items' titles)

BACKLOG ITEMS (ref → title):
{{items}}

=== PRINCIPAL ENGINEER REPORT ===
{{engineerReport}}

=== PRODUCT MANAGER REPORT ===
{{pmReport}}`;

export function refinementSynthesisPrompt(
  engineerReport: string,
  pmReport: string,
  items: RefinementItem[],
  template?: string
): string {
  return renderTemplate(template ?? DEFAULT_REFINEMENT_SYNTHESIS_TEMPLATE, {
    engineerReport,
    pmReport,
    items: itemsIndex(items),
  });
}
