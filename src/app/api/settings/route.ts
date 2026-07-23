import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { readSettings, writeSettings } from '@/server/settings';

/** GET /api/settings -> { goal, memory }. */
export async function GET() {
  try {
    return NextResponse.json(await readSettings());
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/settings {goal?, memory?} -> save the provided fields. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

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
    await writeSettings({ goal: body.goal, memory: body.memory });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
