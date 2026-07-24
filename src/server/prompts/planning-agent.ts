/**
 * CASE: Planning persona pass — one read-only run of the principal-engineer or
 * product-manager persona against the repo.
 *
 * This builds only the wrapper prompt. The persona's own instructions come from
 * the repo's `.claude/agents/*.md` file (read at runtime in planning.ts and
 * passed in as `personaBody`), and the exclusion digest is built in
 * ./planning-exclusions.
 */

export function planningAgentPrompt(personaBody: string, exclusions: string): string {
  const preamble = [
    'Run a planning pass NOW on the repository you are in.',
    'Follow the role instructions below exactly. Do not edit anything and do not',
    'create issues — return your ranked proposals as your final message, in the',
    'output format the instructions specify.',
  ].join(' ');
  const sections = [preamble, exclusions, '---', personaBody].filter(Boolean);
  return sections.join('\n\n');
}
