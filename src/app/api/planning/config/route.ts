import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import {
  getPlanningConfig,
  MAX_PLANNING_TOPICS,
  type PlanningConfig,
  type PlanningRole,
  setPlanningConfig,
} from '@/server/planning';

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

    if ('intervalHours' in body) {
      const h = body.intervalHours;
      if (h !== null && !(isNum(h) && h >= 1 && h <= 168)) {
        return badRequest('intervalHours must be null or a number between 1 and 168');
      }
      patch.intervalHours = h as number | null;
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
    if ('autoStart' in body) {
      if (!isBool(body.autoStart)) return badRequest('autoStart must be a boolean');
      patch.autoStart = body.autoStart;
    }
    for (const key of ['maxActive', 'maxAutoFile', 'maxProposals', 'minImpact', 'maxEffort'] as const) {
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

    await setPlanningConfig(repo, patch);
    return NextResponse.json(await getPlanningConfig(repo));
  } catch (err) {
    return errorResponse(err);
  }
}
