import { NextResponse } from 'next/server';
import { badRequest } from '@/lib/api';
import { getRepo } from '@/server/repos';
import type { RepoInfo } from '@/lib/types';

/**
 * Resolve the required `?repo=<id>` query param through the repo registry.
 *
 * Returns the RepoInfo to pass down to server functions, or a 400 NextResponse
 * to short-circuit with (missing param or unknown id). Callers check with
 * `instanceof NextResponse`.
 */
export async function resolveRepo(request: Request): Promise<RepoInfo | NextResponse> {
  const id = new URL(request.url).searchParams.get('repo');
  if (!id) return badRequest('Missing required "repo" query parameter');
  try {
    return await getRepo(id);
  } catch {
    return badRequest(`Unknown repo id: ${id}`);
  }
}
