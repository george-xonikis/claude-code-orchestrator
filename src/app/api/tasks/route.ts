import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api';
import { ensureLoopStarted } from '@/server/loop';
import { getTasks } from '@/server/state';

/** GET /api/tasks -> Task[] */
export async function GET() {
  try {
    ensureLoopStarted();
    return NextResponse.json(await getTasks());
  } catch (err) {
    return errorResponse(err);
  }
}
