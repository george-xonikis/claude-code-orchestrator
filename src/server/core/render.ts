/**
 * Tiny template renderer shared by every prompt case and the per-repo override
 * machinery (server/prompt-templates.ts). Deliberately minimal:
 *
 * - `{{name}}` — replaced with the variable's value ('' when absent).
 * - `{{#name}}…{{/name}}` — the enclosed block is kept only when the variable
 *   is non-empty (goal/memory sections, the workflow hint).
 * - Runs of 3+ newlines collapse to one blank line after substitution.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{#(\w+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}/g, (_, name: string, inner: string) =>
      vars[name]?.trim() ? inner : ''
    )
    .replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
