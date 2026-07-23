import type { NextRequest } from 'next/server';
import type { LogEvent } from '@/lib/types';
import { badRequest, parseIssueNumber, SSE_HEADERS } from '@/lib/api';
import { ensureLoopStarted } from '@/server/loop';
import { readLogEvents, subscribeLogs } from '@/server/state';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/[n]/logs -> SSE stream of LogEvents: replays the last 200
 * lines from the JSONL file, then streams live events.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ n: string }> }
) {
  const issueNumber = parseIssueNumber((await params).n);
  if (issueNumber === null) return badRequest('Invalid issue number');

  ensureLoopStarted();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: LogEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Subscribe first (buffering) so no live event is lost during replay.
      let replayDone = false;
      const buffered: LogEvent[] = [];
      unsubscribe = subscribeLogs(issueNumber, (event) => {
        if (replayDone) send(event);
        else buffered.push(event);
      });

      for (const event of await readLogEvents(issueNumber, 200)) {
        send(event);
      }
      for (const event of buffered) {
        send(event);
      }
      replayDone = true;

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
