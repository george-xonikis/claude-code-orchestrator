import type { NextRequest } from 'next/server';
import type { Task } from '@/lib/types';
import { SSE_HEADERS } from '@/lib/api';
import { ensureLoopStarted } from '@/server/loop';
import { getTasks, subscribe } from '@/server/state';

export const dynamic = 'force-dynamic';

/** GET /api/events -> SSE stream of full Task[] snapshots on any change. */
export async function GET(request: NextRequest) {
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

      unsubscribe = subscribe(send);
      send(await getTasks()); // Initial snapshot.

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
