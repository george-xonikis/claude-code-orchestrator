import { NextResponse } from 'next/server';
import { badRequest, errorResponse, parseIssueNumber, rejectNonLocal } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { getIssueDetails } from '@/server/github';
import { saveTicketSettings } from '@/server/loop';
import { getTasks } from '@/server/state';

/** GET /api/tasks/[n]/settings?repo= -> {title, body, preferredModel, useWorkflow}. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ n: string }> }
) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;
  const issueNumber = parseIssueNumber((await params).n);
  if (issueNumber === null) return badRequest('Invalid issue number');

  try {
    const [details, tasks] = await Promise.all([
      getIssueDetails(repo.path, issueNumber),
      getTasks(repo.path),
    ]);
    const task = tasks.find((t) => t.issueNumber === issueNumber);
    return NextResponse.json({
      title: details.title,
      body: details.body,
      preferredModel: task?.preferredModel,
      useWorkflow: task?.useWorkflow,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/tasks/[n]/settings?repo= {title?, body?, preferredModel?, useWorkflow?}. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ n: string }> }
) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;
  const issueNumber = parseIssueNumber((await params).n);
  if (issueNumber === null) return badRequest('Invalid issue number');

  try {
    const body = (await request.json().catch(() => null)) as {
      title?: unknown;
      body?: unknown;
      preferredModel?: unknown;
      useWorkflow?: unknown;
    } | null;
    if (!body) return badRequest('Provide settings to save');
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
      return badRequest('title must be a non-empty string');
    }
    if (body.body !== undefined && typeof body.body !== 'string') {
      return badRequest('body must be a string');
    }
    // '' clears the override so the ticket falls back to the repo's model.
    if (
      body.preferredModel !== undefined &&
      (typeof body.preferredModel !== 'string' ||
        (body.preferredModel !== '' && !/^claude-[a-z0-9.-]+$/.test(body.preferredModel)))
    ) {
      return badRequest('preferredModel must be a claude-* model id, or "" to clear it');
    }
    if (body.useWorkflow !== undefined && typeof body.useWorkflow !== 'boolean') {
      return badRequest('useWorkflow must be a boolean');
    }
    await saveTicketSettings(repo, issueNumber, {
      title: body.title as string | undefined,
      body: body.body as string | undefined,
      preferredModel: body.preferredModel as string | undefined,
      useWorkflow: body.useWorkflow as boolean | undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
