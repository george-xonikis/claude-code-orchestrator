import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { removeRepo } from '@/server/repos';

/**
 * DELETE /api/repos/[id] -> remove a repo from the registry only.
 * Never touches the repo's files (.orchestrator/, .worktrees/ stay intact).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const { id } = await params;
  try {
    if (!(await removeRepo(id))) {
      return badRequest(`Unknown repo id: ${id}`);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
