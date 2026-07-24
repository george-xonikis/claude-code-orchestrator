import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { ensurePlanningScheduler, getPlanning } from '@/server/planning';

/** GET /api/planning?repo=<id> -> { passes (newest first), intervalHours }. */
export async function GET(request: Request) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    await ensurePlanningScheduler(repo); // re-arm the auto-run timer after a restart
    const { passes, intervalHours } = await getPlanning(repo);
    return NextResponse.json({ passes, intervalHours });
  } catch (err) {
    return errorResponse(err);
  }
}
