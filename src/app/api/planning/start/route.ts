import { NextResponse } from 'next/server';
import { errorResponse, rejectNonLocal } from '@/lib/api';
import { startPlanningPass } from '@/server/planning';

/** POST /api/planning/start -> run a planning pass (engineer + PM + synthesis). */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  try {
    const passId = await startPlanningPass();
    return NextResponse.json({ ok: true, passId });
  } catch (err) {
    return errorResponse(err);
  }
}
