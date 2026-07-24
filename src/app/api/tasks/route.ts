import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { ensureLoopStarted } from '@/server/loop';
import { getTasks } from '@/server/state';

/** GET /api/tasks?repo=<id> -> Task[] */
export async function GET(request: Request) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    ensureLoopStarted();
    return NextResponse.json(await getTasks(repo.path));
  } catch (err) {
    return errorResponse(err);
  }
}
