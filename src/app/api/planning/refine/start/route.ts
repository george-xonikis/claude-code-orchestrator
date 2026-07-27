import { NextResponse } from 'next/server';
import { errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { startRefinementPass } from '@/server/planning/refinement';

/** POST /api/planning/refine/start?repo=<id> -> run a refinement pass over the open backlog. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const passId = await startRefinementPass(repo);
    return NextResponse.json({ ok: true, passId });
  } catch (err) {
    return errorResponse(err);
  }
}
