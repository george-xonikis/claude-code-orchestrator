import { NextResponse } from 'next/server';
import {
  badRequest,
  errorResponse,
  parseIssueNumber,
  rejectNonLocal,
} from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { startIssue } from '@/server/loop';

/** POST /api/tasks/[n]/start?repo=<id> -> manually start an agent on a ready issue. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ n: string }> }
) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  const issueNumber = parseIssueNumber((await params).n);
  if (issueNumber === null) return badRequest('Invalid issue number');
  try {
    const body = (await request.json().catch(() => null)) as { model?: unknown } | null;
    let model: string | undefined;
    if (body?.model !== undefined) {
      if (typeof body.model !== 'string' || !/^claude-[a-z0-9.-]+$/.test(body.model)) {
        return badRequest('model must be a claude-* model id');
      }
      model = body.model;
    }
    await startIssue(repo, issueNumber, model);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
