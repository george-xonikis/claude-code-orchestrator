import { NextResponse } from 'next/server';
import { errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { cancelPlanningPass } from '@/server/planning/planning';

/** POST /api/planning/cancel?repo=<id> -> abort the in-flight planning pass. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    cancelPlanningPass(repo);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
