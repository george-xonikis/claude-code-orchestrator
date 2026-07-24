/**
 * CASE: Planning persona pass — one read-only run of the principal-engineer or
 * product-manager persona against the repo.
 *
 * This builds only the wrapper prompt. The persona's own instructions come from
 * the repo's `.claude/agents/*.md` file (read at runtime in planning.ts and
 * passed in as `personaBody`), and the exclusion digest is built in
 * ./planning-exclusions.
 */

import type { ProposalShaping } from './planning-synthesis';

/** Steering lines injected into the agent preamble from the plan config. */
function steeringLines(shaping: ProposalShaping): string {
  const lines: string[] = [];
  if (shaping.topics.length > 0) {
    lines.push(
      `Focus your investigation ONLY on work related to: ${shaping.topics.join(
        ', '
      )}. Ignore areas outside these topics.`
    );
  }
  if (shaping.minImpact > 1 || shaping.maxEffort < 5) {
    lines.push(
      `Prefer proposals with impact >= ${shaping.minImpact} and effort <= ${shaping.maxEffort} ` +
        '(1-5 scale); do not surface work outside those bounds.'
    );
  }
  return lines.join(' ');
}

export function planningAgentPrompt(
  personaBody: string,
  exclusions: string,
  shaping: ProposalShaping
): string {
  const preamble = [
    'Run a planning pass NOW on the repository you are in.',
    'Follow the role instructions below exactly. Do not edit anything and do not',
    'create issues — return your ranked proposals as your final message, in the',
    'output format the instructions specify.',
  ].join(' ');
  const sections = [preamble, steeringLines(shaping), exclusions, '---', personaBody].filter(
    Boolean
  );
  return sections.join('\n\n');
}
