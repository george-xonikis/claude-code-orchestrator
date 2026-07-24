import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { dismissProposals } from '@/server/planning';

/** POST /api/planning/dismiss?repo=<id> {passId, proposalIds} -> dismiss pending proposals. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const body = (await request.json().catch(() => null)) as {
      passId?: unknown;
      proposalIds?: unknown;
    } | null;
    if (
      !body ||
      typeof body.passId !== 'string' ||
      !Array.isArray(body.proposalIds) ||
      !body.proposalIds.every((id): id is string => typeof id === 'string')
    ) {
      return badRequest('Provide passId (string) and proposalIds (string[])');
    }
    await dismissProposals(repo, body.passId, body.proposalIds);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
