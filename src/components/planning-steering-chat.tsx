'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Trash2, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  clearPlanningSteering,
  type DiscussionMessage,
  getPlanningSteering,
  sendPlanningSteering,
} from '@/components/shared/task-actions';

/**
 * Ad-hoc planning chat, as a right-side drawer alongside the proposals.
 * Talk through what an ad-hoc planning pass should look for: turns are cheap
 * (no repo scan) and never produce proposals — those come only from running the
 * ad-hoc pass, which injects this transcript into the PE/PM and synthesis
 * prompts. (The API layer still calls this channel "steering".)
 */
export function PlanningSteeringChat({
  repoId,
  onPlan,
  planning,
  canPlan,
  onClose,
}: {
  repoId: string;
  onPlan: () => void;
  planning: boolean;
  canPlan: boolean;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<DiscussionMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getPlanningSteering(repoId).then(setMessages).catch(() => {});
  }, [repoId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, thinking]);

  const send = () => {
    const text = draft.trim();
    if (!text || thinking) return;
    setMessages((prev) => [...prev, { role: 'user', text }]); // optimistic
    setDraft('');
    setThinking(true);
    setError(null);
    sendPlanningSteering(repoId, text)
      .then(setMessages)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setThinking(false));
  };

  const clear = () => {
    if (thinking || messages.length === 0) return;
    setMessages([]);
    clearPlanningSteering(repoId).catch(() => {});
  };

  return (
    <aside className="sticky top-20 flex h-[calc(100dvh-6rem)] w-[26rem] shrink-0 flex-col self-start rounded-lg border border-border bg-main-surface-primary">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="text-sm font-semibold">Ad-hoc planning</div>
        <div className="flex shrink-0 items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clear}
              disabled={thinking}
              aria-label="Clear ad-hoc direction"
              title="Clear the direction so the next pass runs without it"
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-background-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close ad-hoc planning chat"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-background-hover"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto p-4">
        {/* mt-auto anchors the conversation to the bottom, next to the input. */}
        <div className="mt-auto space-y-3">
          {messages.length === 0 && (
            <p className="text-xs leading-5 text-muted-foreground">
              Shape what an ad-hoc pass looks for. Claude won&apos;t write proposals — hit{' '}
              <span className="font-medium">Run ad-hoc pass</span> below when the direction is
              right.
            </p>
          )}
          {messages.map((message, index) =>
            message.role === 'user' ? (
              <div
                key={index}
                className="ml-auto max-w-[90%] whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2 text-sm"
              >
                {message.text}
              </div>
            ) : (
              <div
                key={index}
                className="markdown-preview max-w-[90%] rounded-lg bg-elevated-secondary px-3 py-2 text-sm"
              >
                <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
              </div>
            )
          )}
          {thinking && <p className="text-xs text-muted-foreground">Thinking…</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>

      <div className="border-t border-border p-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder="Focus this round on…"
          className="min-h-[5.25rem] w-full resize-none rounded-md border border-border bg-elevated-secondary px-3 py-2 text-sm placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={thinking || !draft.trim()}
            onClick={send}
            className="inline-flex h-8 flex-1 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            Send
          </button>
          <button
            type="button"
            disabled={planning || !canPlan}
            onClick={onPlan}
            title="Run an ad-hoc planning pass shaped by this conversation"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-elevated-secondary px-3 text-xs font-semibold hover:bg-background-hover disabled:opacity-50"
          >
            {planning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {planning ? 'Running…' : 'Run ad-hoc pass'}
          </button>
        </div>
      </div>
    </aside>
  );
}
