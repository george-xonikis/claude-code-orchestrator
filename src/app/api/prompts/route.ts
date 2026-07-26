import { NextResponse } from 'next/server';
import { badRequest, errorResponse } from '@/lib/api';
import {
  PROMPT_KINDS,
  type PromptKind,
  readPromptTemplates,
  writePromptTemplate,
} from '@/server/knowledge/prompt-templates';

/**
 * App-level session-prompt templates (not repo-scoped: the prompt is Hydra's
 * session envelope; repo-specific instructions live in each repo's .claude/).
 */

/** GET /api/prompts -> { implementation: PromptTemplateState, conflict: ... } */
export async function GET() {
  try {
    return NextResponse.json(await readPromptTemplates());
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/prompts {kind, template} -> save one kind's override (template:
 * null or blank resets to the built-in default). Echoes the full updated
 * state, same shape as GET.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    kind?: unknown;
    template?: unknown;
  } | null;
  if (!body || !PROMPT_KINDS.includes(body.kind as PromptKind)) {
    return badRequest(`Provide "kind": one of ${PROMPT_KINDS.join(', ')}`);
  }
  if (body.template !== null && typeof body.template !== 'string') {
    return badRequest('"template" must be a string, or null to reset to the default');
  }
  try {
    await writePromptTemplate(body.kind as PromptKind, body.template);
    return NextResponse.json(await readPromptTemplates());
  } catch (err) {
    return errorResponse(err);
  }
}
