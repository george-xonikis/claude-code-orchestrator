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
      planningMemory?: unknown;
    } | null;
    if (
      !body ||
      (body.goal === undefined && body.memory === undefined && body.planningMemory === undefined)
    ) {
      return badRequest('Provide goal, memory, and/or planningMemory');
    }
    for (const key of ['goal', 'memory', 'planningMemory'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'string') {
        return badRequest(`${key} must be a string`);
      }
    }
    await writeSettings(repo.path, {
      goal: body.goal as string | undefined,
      memory: body.memory as string | undefined,
      planningMemory: body.planningMemory as string | undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
