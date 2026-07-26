/**
 * CASE: Product-map bootstrap — a one-shot session that writes
 * docs/product-map.md, a concise product brief that spares planning agents a
 * full repository re-scan on every pass.
 *
 * Optional feature: it only runs when a brief-maintainer agent is assigned in
 * the planning config (Settings → Agents). The assigned agent's own `.md` body
 * carries the voice/format instructions ({{agentBody}}); this template is only
 * Hydra's envelope. Static wording is admin-overridable via Settings → Prompts.
 */

import { renderTemplate } from '@/server/core/render';

export const DEFAULT_PRODUCT_MAP_TEMPLATE = `You are the product-brief maintainer for this repository.

{{agentBody}}

---

Do this NOW:

1. Explore the repository until you understand what the product actually does:
   its features, its user flows, and its main modules and how they connect.
2. WRITE the file docs/product-map.md — a concise, skimmable map of what the
   product does (features, user flows, main modules). Its purpose is to spare
   planning agents a full repository re-scan: a reader should get an accurate
   picture of the product from this one file. Prefer short sections and
   bullets over prose; skip implementation trivia.

Rules:
- Write ONLY docs/product-map.md. Do not modify any other file.
- Leave the file UNCOMMITTED — the developer reviews and commits it themselves.
  Do not run git commit, git add, or open a PR.`;

export function buildProductMapPrompt(agentBody: string, template?: string): string {
  return renderTemplate(template ?? DEFAULT_PRODUCT_MAP_TEMPLATE, {
    agentBody: agentBody.trim(),
  });
}
