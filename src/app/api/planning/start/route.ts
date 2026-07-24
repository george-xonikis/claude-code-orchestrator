import { NextResponse } from 'next/server';
import { errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { startPlanningPass } from '@/server/planning';

/** POST /api/planning/start?repo=<id> -> run a planning pass (engineer + PM + synthesis). */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const passId = await startPlanningPass(repo);
    return NextResponse.json({ ok: true, passId });
  } catch (err) {
    return errorResponse(err);
  }
}
