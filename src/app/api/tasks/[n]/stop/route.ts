import { NextResponse } from 'next/server';
import {
  badRequest,
  errorResponse,
  parseIssueNumber,
  rejectNonLocal,
} from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { stopIssue } from '@/server/loop/loop';

/** POST /api/tasks/[n]/stop?repo=<id> -> stop the agent session on an issue. */
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
    await stopIssue(repo, issueNumber);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
