import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api';
import { ensurePlanningScheduler, getPlanning } from '@/server/planning';

/** GET /api/planning -> { passes (newest first), intervalHours }. */
export async function GET() {
  try {
    await ensurePlanningScheduler(); // re-arm the auto-run timer after a restart
    const { passes, intervalHours } = await getPlanning();
    return NextResponse.json({ passes, intervalHours });
  } catch (err) {
    return errorResponse(err);
  }
}
