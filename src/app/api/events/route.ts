import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Task } from '@/lib/types';
import { SSE_HEADERS } from '@/lib/api';
import { resolveRepo } from '@/lib/repo-params';
import { ensureLoopStarted } from '@/server/loop';
import { getTasks, subscribe } from '@/server/state';

export const dynamic = 'force-dynamic';

/** GET /api/events?repo=<id> -> SSE stream of full Task[] snapshots on any change. */
export async function GET(request: NextRequest) {
  const repo = await resolveRepo(request);
  if (repo instanceof NextResponse) return repo;

  ensureLoopStarted();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (tasks: Task[]) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(tasks)}\n\n`));
        } catch {
          closed = true;
        }
      };

      unsubscribe = subscribe(repo.path, send);
      send(await getTasks(repo.path)); // Initial snapshot.

      request.signal.addEventListener('abort', () => {
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
