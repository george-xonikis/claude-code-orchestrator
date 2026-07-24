/**
 * CASE: Synthesis step — merges the Principal Engineer and Product Manager
 * proposal lists into ONE deduped, ranked list and demands STRICT JSON output
 * (title, body with fixed sections, labels, source, effort 1-5, impact 1-5).
 */

/** Config-driven steering applied to a planning pass's output. */
export interface ProposalShaping {
  /** Free-text focus topics; empty = no topic constraint. */
  topics: string[];
  /** Only keep proposals with impact >= this (1-5; 1 = no floor). */
  minImpact: number;
  /** Only keep proposals with effort <= this (1-5; 5 = no ceiling). */
  maxEffort: number;
  /** Max proposals to return. */
  maxProposals: number;
}

/** Human-readable constraint lines for the active parts of a shaping config. */
function shapingConstraints(shaping: ProposalShaping): string[] {
  const lines: string[] = [];
  if (shaping.topics.length > 0) {
    lines.push(
      `- FOCUS: only propose work related to these topics — ${shaping.topics.join(
        ', '
      )}. Drop anything unrelated, even if otherwise valuable.`
    );
  }
  if (shaping.minImpact > 1) {
    lines.push(`- Drop any item with impact below ${shaping.minImpact} (1-5 scale).`);
  }
  if (shaping.maxEffort < 5) {
    lines.push(`- Drop any item with effort above ${shaping.maxEffort} (1-5 scale).`);
  }
  return lines;
}

export function synthesisPrompt(
  engineerReport: string,
  pmReport: string,
  exclusions: string,
  shaping: ProposalShaping
): string {
  return [
    'You are the synthesis step of a planning meeting between a Principal',
    'Engineer and a Product Manager. Their independent proposal lists are below.',
    'ONE of the two reports may be empty — that means only that role ran this',
    'pass. In that case just normalize and rank that role\'s proposals (set',
    'source to the role that ran); do NOT invent proposals for the missing role.',
    'Merge them into ONE deduped list:',
    '- When both describe the same underlying work, merge into a single item',
    '  with source "both", combining the PM problem/outcome framing with the',
    "  engineer's code anchors (the anchors go in Technical details, not Problem).",
    '- Drop anything that serves no stated goal priority.',
    `- Keep at most ${shaping.maxProposals} items, ranked by leverage.`,
    ...shapingConstraints(shaping),
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
    'objects with keys: title (string, <=70 chars), body, labels, source, effort,',
    'impact.',
    '',
    'body is a markdown string with EXACTLY these sections, in this order:',
    '  "## Problem" — the user/business pain in plain language. Make it easy to',
    '    skim: use a short bulleted or numbered list, not dense prose.',
    '  "## Proposed direction" — the approach in plain language (what changes and',
    '    why), also easy to skim.',
    '  "## Success criteria" — a checklist of how we know it is done.',
    '  "## Technical details" — LAST. This is the ONLY section allowed to mention',
    '    code: file paths, function/symbol names, and implementation notes all go',
    '    here. Problem, Proposed direction, and Success criteria must contain NO',
    '    code, file, function, or symbol references. Omit this section only if',
    '    there are genuinely none.',
    '',
    'labels (array from: Bug, FE, BE, AI, Infra), source ("engineer"|"pm"|"both"),',
    'effort (integer 1-5, 1=trivial 5=very large), impact (integer 1-5, 1=marginal 5=critical).',
    '',
    '=== PRINCIPAL ENGINEER REPORT ===',
    engineerReport,
    '',
    '=== PRODUCT MANAGER REPORT ===',
    pmReport,
  ].join('\n');
}
