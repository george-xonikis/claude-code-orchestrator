import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { resolveRefinementVerdict } from '@/server/planning/refinement';

/**
 * POST /api/planning/refine/apply?repo=<id> {passId, verdictId, action}
 * -> resolve one refinement verdict: "apply" executes it (dismiss/close/rewrite),
 * "reject" just records that the developer declined it.
 */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const body = (await request.json().catch(() => null)) as {
      passId?: unknown;
      verdictId?: unknown;
      action?: unknown;
    } | null;
    if (
      !body ||
      typeof body.passId !== 'string' ||
      typeof body.verdictId !== 'string' ||
      (body.action !== 'apply' && body.action !== 'reject')
    ) {
      return badRequest('Provide passId (string), verdictId (string), and action ("apply"|"reject")');
    }
    await resolveRefinementVerdict(repo, body.passId, body.verdictId, body.action);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
