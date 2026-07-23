import { NextResponse } from 'next/server';

/** Shared helpers for the thin route handlers under src/app/api. */

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

/** Parse the [n] route segment into a positive integer issue number, or null. */
export function parseIssueNumber(n: string): number | null {
  const value = Number(n);
  return Number.isInteger(value) && value > 0 ? value : null;
}

const LOCAL_HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * CSRF / DNS-rebinding guard for state-mutating routes. Cross-origin
 * `text/plain` POSTs skip the preflight, so before acting we require:
 * - a localhost Host header (defeats DNS rebinding), and
 * - when an Origin header is present (browsers always send it on POST),
 *   a localhost origin (defeats cross-origin form/fetch CSRF).
 * Returns a 403 response to short-circuit with, or null if the request is OK.
 */
export function rejectNonLocal(request: Request): NextResponse | null {
  const host = request.headers.get('host');
  if (!host || !LOCAL_HOST_PATTERN.test(host)) {
    return NextResponse.json(
      { error: 'Forbidden: requests must target localhost' },
      { status: 403 }
    );
  }
  const origin = request.headers.get('origin');
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!originHost || !LOCAL_HOST_PATTERN.test(originHost)) {
      return NextResponse.json(
        { error: 'Forbidden: cross-origin requests are not allowed' },
        { status: 403 }
      );
    }
  }
  return null;
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function errorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: message }, { status: 500 });
}
