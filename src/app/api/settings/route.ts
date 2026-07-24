import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { readSettings, writeSettings } from '@/server/settings';

/** GET /api/settings?repo=<id> -> { goal, memory }. */
export async function GET(request: Request) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    return NextResponse.json(await readSettings(repo.path));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/settings?repo=<id> {goal?, memory?} -> save the provided fields. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const body = (await request.json().catch(() => null)) as {
      goal?: unknown;
      memory?: unknown;
    } | null;
    if (!body || (body.goal === undefined && body.memory === undefined)) {
      return badRequest('Provide goal and/or memory');
    }
    if (body.goal !== undefined && typeof body.goal !== 'string') {
      return badRequest('goal must be a string');
    }
    if (body.memory !== undefined && typeof body.memory !== 'string') {
      return badRequest('memory must be a string');
    }
    await writeSettings(repo.path, { goal: body.goal, memory: body.memory });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
