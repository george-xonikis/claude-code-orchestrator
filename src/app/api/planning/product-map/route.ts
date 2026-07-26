import { NextResponse } from 'next/server';
import { errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { getProductMapState, setProductMapRun } from '@/server/planning/planning';
import { isProductMapRunning, runProductMapBootstrap } from '@/server/planning/product-map';

/** GET /api/planning/product-map?repo=<id> -> { run: last bootstrap state | null }. */
export async function GET(request: Request) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    let run = await getProductMapState(repo);
    // Zombie recovery: the store says "running" but no session is in flight in
    // this process — the server restarted mid-bootstrap. Persist the failure so
    // the button unlocks instead of staying disabled forever.
    if (run?.status === 'running' && !isProductMapRunning(repo)) {
      run = {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: 'Interrupted — the server restarted while the bootstrap was running',
      };
      await setProductMapRun(repo.path, run);
    }
    return NextResponse.json({ run });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/planning/product-map?repo=<id> -> start the product-map bootstrap
 * (fire-and-forget; poll GET for the outcome). 409 while one is running;
 * requires briefAgent to be assigned in the planning config.
 */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  if (isProductMapRunning(repo)) {
    return NextResponse.json(
      { error: 'A product-map bootstrap is already running for this repository' },
      { status: 409 }
    );
  }
  try {
    await runProductMapBootstrap(repo);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
