import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { ensurePlanningScheduler, getPlanning } from '@/server/planning/planning';
import { ensureRefinementScheduler } from '@/server/planning/refinement';

/** GET /api/planning?repo=<id> -> { passes (newest first), refinementPasses, intervalHours, productMapRun }. */
export async function GET(request: Request) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    // Re-arm both auto-run timers after a restart.
    await ensurePlanningScheduler(repo);
    await ensureRefinementScheduler(repo);
    const { passes, refinementPasses, intervalHours, productMapRun } = await getPlanning(repo);
    return NextResponse.json({
      passes,
      refinementPasses,
      intervalHours,
      productMapRun: productMapRun ?? null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
