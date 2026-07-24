import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { getAutonomyConfig, setAutonomyConfig } from '@/server/planning';

/** GET /api/planning/autonomy?repo=<id> -> { autonomous, maxActive, maxAutoFile }. */
export async function GET(request: Request) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    return NextResponse.json(await getAutonomyConfig(repo));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/planning/autonomy?repo=<id> {autonomous?, maxActive?, maxAutoFile?} -> patch config. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const body = (await request.json().catch(() => null)) as {
      autonomous?: unknown;
      maxActive?: unknown;
      maxAutoFile?: unknown;
    } | null;
    if (!body) return badRequest('Provide autonomous, maxActive, and/or maxAutoFile');

    const patch: Parameters<typeof setAutonomyConfig>[1] = {};
    if (body.autonomous !== undefined) {
      if (typeof body.autonomous !== 'boolean') return badRequest('autonomous must be a boolean');
      patch.autonomous = body.autonomous;
    }
    if (body.maxActive !== undefined) {
      if (typeof body.maxActive !== 'number' || !Number.isFinite(body.maxActive)) {
        return badRequest('maxActive must be a number');
      }
      patch.maxActive = body.maxActive;
    }
    if (body.maxAutoFile !== undefined) {
      if (typeof body.maxAutoFile !== 'number' || !Number.isFinite(body.maxAutoFile)) {
        return badRequest('maxAutoFile must be a number');
      }
      patch.maxAutoFile = body.maxAutoFile;
    }

    await setAutonomyConfig(repo, patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
