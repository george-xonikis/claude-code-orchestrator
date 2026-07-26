/**
 * CASE: Exclusion digest — the "PREVIOUSLY PROPOSED — do NOT re-propose" block
 * injected into both persona prompts (./planning-agent) and the synthesis prompt
 * (./planning-synthesis), so agents don't waste effort re-discovering work the
 * developer already saw. Returns '' when there is nothing to exclude.
 */

import type { PlanningPass } from '@/lib/types';

export function exclusionDigest(passes: PlanningPass[]): string {
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
