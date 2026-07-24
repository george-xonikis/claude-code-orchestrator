import { NextResponse } from 'next/server';
import { errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { pollNow } from '@/server/loop';

/** POST /api/poll?repo=<id> -> run one poll cycle immediately ("Poll now"). */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    await pollNow(repo);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
