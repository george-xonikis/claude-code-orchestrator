import { NextResponse } from 'next/server';
import { errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { cancelRefinementPass } from '@/server/planning/refinement';

/** POST /api/planning/refine/cancel?repo=<id> -> abort the in-flight refinement pass. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    cancelRefinementPass(repo);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
