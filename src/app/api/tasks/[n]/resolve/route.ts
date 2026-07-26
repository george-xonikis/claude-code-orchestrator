import { NextResponse } from 'next/server';
import {
  badRequest,
  errorResponse,
  parseIssueNumber,
  rejectNonLocal,
} from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { resolveConflictsIssue } from '@/server/loop/loop';

/** POST /api/tasks/[n]/resolve?repo=<id> -> start a conflict-resolution session for the issue's open PR. */
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
    await resolveConflictsIssue(repo, issueNumber);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
