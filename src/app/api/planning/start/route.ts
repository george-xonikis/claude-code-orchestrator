import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { type PlanningRole, startPlanningPass } from '@/server/planning/planning';

const PLANNING_ROLES: readonly PlanningRole[] = ['engineer', 'pm'];

/**
 * POST /api/planning/start?repo=<id> {roles?: ('engineer'|'pm')[], adHoc?: boolean}
 * -> run a planning pass. Omit roles (or send both) for the full PE + PM pass;
 * send a single role to run just that agent. adHoc: true marks a developer-driven
 * ad-hoc pass — the only kind that injects the ad-hoc planning chat transcript.
 */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const body = (await request.json().catch(() => null)) as {
      roles?: unknown;
      adHoc?: unknown;
    } | null;
    let roles: PlanningRole[] | undefined;
    if (body?.roles !== undefined) {
      if (
        !Array.isArray(body.roles) ||
        body.roles.length === 0 ||
        !body.roles.every((r): r is PlanningRole => PLANNING_ROLES.includes(r as PlanningRole))
      ) {
        return badRequest('roles must be a non-empty array of "engineer" and/or "pm"');
      }
      roles = [...new Set(body.roles)];
    }
    if (body?.adHoc !== undefined && typeof body.adHoc !== 'boolean') {
      return badRequest('adHoc must be a boolean');
    }
    const passId = await startPlanningPass(repo, {
      ...(roles ? { roles } : {}),
      ...(body?.adHoc !== undefined ? { adHoc: body.adHoc } : {}),
    });
    return NextResponse.json({ ok: true, passId });
  } catch (err) {
    return errorResponse(err);
  }
}
