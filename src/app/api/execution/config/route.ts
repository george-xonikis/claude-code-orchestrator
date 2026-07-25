import { NextResponse } from 'next/server';
import { badRequest, errorResponse, rejectNonLocal } from '@/lib/api';
import { isKnownModel, MODEL_OPTIONS } from '@/lib/models';
import { resolveRepo } from '@/lib/repo-params';
import { type ExecutionConfig, getExecutionConfig, setExecutionConfig } from '@/server/execution';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** GET /api/execution/config?repo=<id> -> the full execution config. */
export async function GET(request: Request) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    return NextResponse.json(await getExecutionConfig(repo));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/execution/config?repo=<id> {partial config} -> validate + persist. */
export async function POST(request: Request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return badRequest('Provide a config patch object');

    const patch: Partial<ExecutionConfig> = {};

    if ('autoStart' in body) {
      if (!isBool(body.autoStart)) return badRequest('autoStart must be a boolean');
      patch.autoStart = body.autoStart;
    }
    if ('queueOrder' in body) {
      if (body.queueOrder !== 'oldest' && body.queueOrder !== 'newest') {
        return badRequest('queueOrder must be "oldest" or "newest"');
      }
      patch.queueOrder = body.queueOrder;
    }
    if ('maxActive' in body) {
      if (!isNum(body.maxActive)) return badRequest('maxActive must be a number');
      patch.maxActive = body.maxActive;
    }
    for (const key of ['pollMinutes', 'tasksPerRun'] as const) {
      if (key in body) {
        if (body[key] !== null && !isNum(body[key])) {
          return badRequest(`${key} must be a number or null`);
        }
        patch[key] = body[key] as number | null;
      }
    }
    if ('manualQueue' in body) {
      if (
        !Array.isArray(body.manualQueue) ||
        !body.manualQueue.every((n) => typeof n === 'number' && Number.isInteger(n))
      ) {
        return badRequest('manualQueue must be an array of issue numbers');
      }
      patch.manualQueue = body.manualQueue as number[];
    }
    if ('reviewerAgents' in body) {
      if (!Array.isArray(body.reviewerAgents) || !body.reviewerAgents.every((a) => typeof a === 'string')) {
        return badRequest('reviewerAgents must be an array of strings');
      }
      patch.reviewerAgents = body.reviewerAgents as string[];
    }
    if ('executionModel' in body) {
      if (!isKnownModel(body.executionModel)) {
        return badRequest(
          `executionModel must be one of: ${MODEL_OPTIONS.map((m) => m.id).join(', ')}`
        );
      }
      patch.executionModel = body.executionModel;
    }

    return NextResponse.json(await setExecutionConfig(repo, patch));
  } catch (err) {
    return errorResponse(err);
  }
}
