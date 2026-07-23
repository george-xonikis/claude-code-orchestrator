import { NextResponse } from 'next/server';
import { badRequest, errorResponse, parseIssueNumber, rejectNonLocal } from '@/lib/api';
import { pushIssue } from '@/server/loop';

/** POST /api/tasks/[n]/push -> push the committed branch and open its PR. */
export async function POST(
  request: Request,
  context: { params: Promise<{ n: string }> }
) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const { n } = await context.params;
  const issueNumber = parseIssueNumber(n);
  if (issueNumber === null) return badRequest('Invalid issue number');

  try {
    await pushIssue(issueNumber);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
