import { NextResponse } from 'next/server';
import { badRequest, errorResponse, parseIssueNumber, rejectNonLocal } from '@/lib/api';
import { setIssueStatus } from '@/server/loop';

/** POST /api/tasks/[n]/status {status} -> manually override a task's status. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ n: string }> }
) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const issueNumber = parseIssueNumber((await params).n);
  if (issueNumber === null) return badRequest('Invalid issue number');

  try {
    const body = (await request.json().catch(() => null)) as { status?: string } | null;
    if (body?.status !== 'ready' && body?.status !== 'committed' && body?.status !== 'failed') {
      return badRequest("status must be 'ready', 'committed', or 'failed'");
    }
    await setIssueStatus(issueNumber, body.status);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
