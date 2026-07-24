import { NextResponse } from 'next/server';
import { badRequest, errorResponse, parseIssueNumber, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { pushIssue } from '@/server/loop';

/** POST /api/tasks/[n]/push?repo=<id> -> push the committed branch and open its PR. */
export async function POST(
  request: Request,
  context: { params: Promise<{ n: string }> }
) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  const { n } = await context.params;
  const issueNumber = parseIssueNumber(n);
  if (issueNumber === null) return badRequest('Invalid issue number');

  try {
    await pushIssue(repo, issueNumber);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
