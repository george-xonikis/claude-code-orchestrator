import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { listRepoAgents } from '@/server/core/agents';

/** GET /api/agents?repo=<id> -> AgentMeta[] discovered under the repo's .claude/agents/. */
export async function GET(request: Request) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    return NextResponse.json(await listRepoAgents(repo.path));
  } catch (err) {
    return errorResponse(err);
  }
}
