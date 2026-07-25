import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import {
  getPlanningSteering,
  sendPlanningSteering,
  setPlanningSteering,
} from '@/server/planning';

/** GET /api/planning/steering?repo=<id> -> the stored steering transcript. */
export async function GET(request: Request) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    return NextResponse.json({ messages: await getPlanningSteering(repo) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/planning/steering?repo=<id> {text} -> one chat turn; returns the transcript. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
    if (!body || typeof body.text !== 'string' || !body.text.trim()) {
      return badRequest('Provide a non-empty text');
    }
    return NextResponse.json({ messages: await sendPlanningSteering(repo, body.text.trim()) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/planning/steering?repo=<id> -> clear the steering transcript. */
export async function DELETE(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    return NextResponse.json({ messages: await setPlanningSteering(repo, []) });
  } catch (err) {
    return errorResponse(err);
  }
}
