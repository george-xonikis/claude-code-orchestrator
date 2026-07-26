import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api';
import { isNonAgentTask } from '@/lib/task-helpers';
import type { OverviewSession, RepoOverview, Task, TaskStatus } from '@/lib/types';
import { getExecutionConfig } from '@/server/execution/config';
import { getPlanning } from '@/server/planning/planning';
import { loadRepos } from '@/server/core/repos';
import { getTasks } from '@/server/state/state';

/**
 * GET /api/overview -> RepoOverview[] — every registered repo's roll-up in one
 * request, so the fleet page polls once instead of 3×N repo-scoped calls.
 */

const EMPTY_COUNTS: Record<TaskStatus, number> = {
  ready: 0,
  working: 0,
  needs_input: 0,
  committed: 0,
  pr_open: 0,
  failed: 0,
};

function toSession(task: Task): OverviewSession {
  return {
    issueNumber: task.issueNumber,
    title: task.title,
    status: task.status as OverviewSession['status'],
    ...(task.model ? { model: task.model } : {}),
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
  };
}

export async function GET() {
  try {
    const repos = await loadRepos();
    const overviews = await Promise.all(
      repos.map(async (repo): Promise<RepoOverview> => {
        const [tasks, config, planning] = await Promise.all([
          getTasks(repo.path),
          getExecutionConfig(repo),
          getPlanning(repo).catch(() => null),
        ]);

        const counts = { ...EMPTY_COUNTS };
        let lastActivityAt: string | undefined;
        for (const task of tasks) {
          counts[task.status] += 1;
          if (task.updatedAt && (!lastActivityAt || task.updatedAt > lastActivityAt)) {
            lastActivityAt = task.updatedAt;
          }
        }

        const sessions = tasks
          .filter((task) => task.status === 'working' || task.status === 'needs_input')
          // Working first (they're what's burning tokens), then oldest first.
          .sort(
            (a, b) =>
              (a.status === 'needs_input' ? 1 : 0) - (b.status === 'needs_input' ? 1 : 0) ||
              (a.startedAt ?? '').localeCompare(b.startedAt ?? '')
          )
          .map(toSession);

        return {
          repo,
          counts,
          sessions,
          queueCount: tasks.filter((task) => task.status === 'ready' && !isNonAgentTask(task))
            .length,
          autoStart: config.autoStart,
          maxActive: config.maxActive,
          planningRunning: planning?.passes[0]?.status === 'running',
          ...(lastActivityAt ? { lastActivityAt } : {}),
        };
      })
    );
    return NextResponse.json(overviews);
  } catch (err) {
    return errorResponse(err);
  }
}
