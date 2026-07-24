import { NextResponse, type NextRequest } from 'next/server';
import { rejectNonLocal } from '@/lib/api';

/**
 * Runs before every /api route (reads, mutations, and SSE streams alike) and
 * rejects requests whose Host (or Origin, when present) is not localhost.
 * Defeats DNS rebinding against read endpoints — the dashboard serves absolute
 * filesystem paths, goal/memory content, and live logs, none of which may be
 * readable by a page on an attacker-controlled hostname that re-resolves to
 * 127.0.0.1. Mutating handlers additionally call rejectNonLocal themselves
 * (defense in depth).
 */
export function proxy(request: NextRequest): NextResponse {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
