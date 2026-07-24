import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { addRepo, loadRepos } from '@/server/repos';

/** GET /api/repos -> RepoInfo[] (including hasPersonas per repo). */
export async function GET() {
  try {
    return NextResponse.json(await loadRepos());
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/repos {path, name?} -> register a local git repo, returns its RepoInfo. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const body = (await request.json().catch(() => null)) as {
    path?: unknown;
    name?: unknown;
  } | null;
  if (!body || typeof body.path !== 'string' || body.path.trim().length === 0) {
    return badRequest('Provide "path": an absolute path or git URL');
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    return badRequest('"name" must be a string');
  }
  try {
    return NextResponse.json(await addRepo(body.path.trim(), body.name));
  } catch (err) {
    // addRepo failures are input-validation problems (missing dir, not a git
    // repo, no origin remote) — surface them as 400 with the message.
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}
