/**
 * CASE: Synthesis step — merges the Principal Engineer and Product Manager
 * proposal lists into ONE deduped, ranked list and demands STRICT JSON output
 * (title, body with fixed sections, labels, source, effort 1-5, impact 1-5).
 */

export function synthesisPrompt(
  engineerReport: string,
  pmReport: string,
  exclusions: string
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
    'effort (integer 1-5, 1=trivial 5=very large), impact (integer 1-5, 1=marginal 5=critical).',
    '',
    '=== PRINCIPAL ENGINEER REPORT ===',
    engineerReport,
    '',
    '=== PRODUCT MANAGER REPORT ===',
    pmReport,
  ].join('\n');
}
