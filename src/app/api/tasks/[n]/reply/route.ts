import { NextResponse } from 'next/server';
import {
  badRequest,
  errorResponse,
  parseIssueNumber,
  rejectNonLocal,
} from '@/lib/api';
import { ensureLoopStarted } from '@/server/loop';
import { replySession } from '@/server/sessions';

/**
 * POST /api/tasks/[n]/reply {message} -> answer a session paused in needs_input.
 * The session resumes and its status flips back to working via session events.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ n: string }> }
) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const issueNumber = parseIssueNumber((await params).n);
  if (issueNumber === null) return badRequest('Invalid issue number');

  let message: unknown;
  try {
    message = ((await request.json()) as { message?: unknown }).message;
  } catch {
    return badRequest('Request body must be JSON');
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    return badRequest('Field "message" must be a non-empty string');
  }

  try {
    ensureLoopStarted();
    await replySession(issueNumber, message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
