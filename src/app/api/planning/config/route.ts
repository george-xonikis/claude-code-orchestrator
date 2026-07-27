import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { isKnownModel, MODEL_OPTIONS } from '@/lib/models';
import { resolveRepo } from '@/lib/repo-params';
import {
  getPlanningConfig,
  MAX_PLANNING_TOPICS,
  type PlanningConfig,
  type PlanningRole,
  setPlanningConfig,
} from '@/server/planning/planning';
import { ensureRefinementScheduler } from '@/server/planning/refinement';

const ROLES: readonly PlanningRole[] = ['engineer', 'pm'];

const isRole = (r: unknown): r is PlanningRole => ROLES.includes(r as PlanningRole);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** GET /api/planning/config?repo=<id> -> the full planning config. */
export async function GET(request: Request) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    return NextResponse.json(await getPlanningConfig(repo));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/planning/config?repo=<id> {partial config} -> validate + persist. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return badRequest('Provide a config patch object');

    const patch: Partial<PlanningConfig> = {};

    for (const key of ['intervalHours', 'refinementIntervalHours'] as const) {
      if (key in body) {
        const h = body[key];
        if (h !== null && !(isNum(h) && h >= 1 && h <= 168)) {
          return badRequest(`${key} must be null or a number between 1 and 168`);
        }
        patch[key] = h as number | null;
      }
    }
    if ('roles' in body) {
      if (!Array.isArray(body.roles) || body.roles.length === 0 || !body.roles.every(isRole)) {
        return badRequest('roles must be a non-empty array of "engineer" and/or "pm"');
      }
      patch.roles = [...new Set(body.roles as PlanningRole[])];
    }
    if ('autoFile' in body) {
      if (!isBool(body.autoFile)) return badRequest('autoFile must be a boolean');
      patch.autoFile = body.autoFile;
    }
    for (const key of ['maxAutoFile', 'maxProposals', 'minImpact', 'maxEffort'] as const) {
      if (key in body) {
        if (!isNum(body[key])) return badRequest(`${key} must be a number`);
        patch[key] = body[key] as number;
      }
    }
    if ('topics' in body) {
      if (
        !Array.isArray(body.topics) ||
        !body.topics.every((t) => typeof t === 'string') ||
        body.topics.length > MAX_PLANNING_TOPICS
      ) {
        return badRequest(`topics must be an array of at most ${MAX_PLANNING_TOPICS} strings`);
      }
      patch.topics = body.topics as string[];
    }
    for (const key of ['peAgent', 'pmAgent', 'briefAgent'] as const) {
      if (key in body) {
        if (body[key] !== null && typeof body[key] !== 'string') {
          return badRequest(`${key} must be an agent name string or null`);
        }
        patch[key] = body[key] as string | null;
      }
    }
    if ('planningModel' in body) {
      if (!isKnownModel(body.planningModel)) {
        return badRequest(
          `planningModel must be one of ${MODEL_OPTIONS.map((m) => m.id).join(', ')}`
        );
      }
      patch.planningModel = body.planningModel;
    }

    await setPlanningConfig(repo, patch);
    // setPlanningConfig re-arms the planning timer itself; the refinement timer
    // is armed here to keep refinement.ts's dependency on planning.ts one-way.
    if (patch.refinementIntervalHours !== undefined) await ensureRefinementScheduler(repo);
    return NextResponse.json(await getPlanningConfig(repo));
  } catch (err) {
    return errorResponse(err);
  }
}
