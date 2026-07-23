import { NextResponse } from 'next/server';
import { errorResponse, rejectNonLocal } from '@/lib/api';
import { pollNow } from '@/server/loop';

/** POST /api/poll -> run one poll cycle immediately ("Poll now"). */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  try {
    await pollNow();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
