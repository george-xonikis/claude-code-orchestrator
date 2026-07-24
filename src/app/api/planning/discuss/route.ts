import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { clearProposalDiscussion, discussProposal, type DiscussionMessage } from '@/server/planning';

function isMessage(value: unknown): value is DiscussionMessage {
  const m = value as DiscussionMessage;
  return (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string';
}

/** POST /api/planning/discuss?repo= {passId, proposalId, messages} -> {reply}. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const body = (await request.json().catch(() => null)) as {
      passId?: unknown;
      proposalId?: unknown;
      messages?: unknown;
    } | null;
    if (
      !body ||
      typeof body.passId !== 'string' ||
      typeof body.proposalId !== 'string' ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      !body.messages.every(isMessage)
    ) {
      return badRequest('Provide passId, proposalId, and a non-empty messages array');
    }
    const reply = await discussProposal(repo, body.passId, body.proposalId, body.messages);
    return NextResponse.json({ reply });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/planning/discuss?repo= {passId, proposalId} -> clear the transcript. */
export async function DELETE(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const body = (await request.json().catch(() => null)) as {
      passId?: unknown;
      proposalId?: unknown;
    } | null;
    if (!body || typeof body.passId !== 'string' || typeof body.proposalId !== 'string') {
      return badRequest('Provide passId and proposalId');
    }
    await clearProposalDiscussion(repo, body.passId, body.proposalId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
