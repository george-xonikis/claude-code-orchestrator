import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { setPlanningInterval } from '@/server/planning';

/** POST /api/planning/interval {hours: number | null} -> set the auto-run interval. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  try {
    const body = (await request.json().catch(() => null)) as { hours?: unknown } | null;
    const hours = body?.hours;
    const valid =
      hours === null || (typeof hours === 'number' && Number.isFinite(hours) && hours >= 1 && hours <= 168);
    if (!body || !valid) {
      return badRequest('hours must be null or a number between 1 and 168');
    }
    await setPlanningInterval(hours as number | null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
