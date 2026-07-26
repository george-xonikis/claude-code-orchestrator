import {
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { DEFAULT_EXECUTION_MODEL } from '@/lib/models';
import type { LogEvent, RepoInfo, Task } from '@/lib/types';
import type { OutcomeMapper, SessionOutcome } from '@/server/execution/flows/types';
import {
  ASK_USER_QUESTION_DESCRIPTION,
  ASK_USER_TOOL_DESCRIPTION,
} from '@/server/execution/prompts';

/**
 * Agent session RUNTIME, backed by the TypeScript Claude Agent SDK
 * (@anthropic-ai/claude-agent-sdk). Pure mechanics: launch a prompt in a
 * worktree, stream events, keep the session alive across ask_user pauses, and
 * report how it ended.
 *
 * FLOW-AGNOSTIC BY DESIGN: what a session is FOR (implementing an issue,
 * resolving PR conflicts, …) lives in src/server/flows/*. A flow hands
 * startSession the finished prompt and an OutcomeMapper; the runtime never
 * branches on flow kind.
 *
 * Sessions are fire-and-forget but may ask ONE-turn questions: the session pauses
 * (task status 'needs_input') until replySession() delivers the user's answer, then
 * resumes with full context.
 *
 * POLICY LIVES IN THE REPO, NOT HERE. Hydra only manages the session lifecycle;
 * what an agent may or may not do is governed by the managed repo's own rules —
 * CLAUDE.md, .claude/settings.json permissions (loaded via settingSources:
 * ['project'] and enforced by the SDK), skills, and agents. Hydra auto-approves
 * whatever the repo's rules don't decide, so sessions never hang on a prompt.
 *
 * The live-session registry is lazily initialized behind a globalThis guard so
 * Next dev hot-reload doesn't duplicate running sessions.
 */

/** Event emitted by a running session: a log line and/or a Task patch (status change, cost, PR, question…). */
export interface SessionEvent {
  /** The managed repo this session belongs to — issue numbers are only unique per repo. */
  repo: RepoInfo;
  issueNumber: number;
  log?: LogEvent;
  patch?: Partial<Task>;
}

export type SessionEventListener = (event: SessionEvent) => void;

// ---------------------------------------------------------------------------
// Streaming-input queue (keeps the SDK session alive while a question is pending)
// ---------------------------------------------------------------------------

interface InputQueue {
  push(message: SDKUserMessage): void;
  end(): void;
  iterable: AsyncIterable<SDKUserMessage>;
}

function createInputQueue(): InputQueue {
  const buffer: SDKUserMessage[] = [];
  let ended = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  return {
    push(message) {
      if (ended) return;
      buffer.push(message);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (buffer.length > 0) {
            yield buffer.shift() as SDKUserMessage;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// globalThis-guarded registry
// ---------------------------------------------------------------------------

interface LiveSession {
  repo: RepoInfo;
  issueNumber: number;
  query: Query;
  input: InputQueue;
  /** Resolver for a pending ask_user tool call; non-null while status is needs_input. */
  pendingReply: ((answer: string) => void) | null;
  stopped: boolean;
  /** The owning flow's outcome mapping (terminal status + result log). */
  mapOutcome: OutcomeMapper;
  prUrl?: string;
  prNumber?: number;
}

interface SessionsGlobal {
  /** Keyed by `${repoId}#${issueNumber}` — issue numbers are not unique across repos. */
  sessions: Map<string, LiveSession>;
  listeners: Set<SessionEventListener>;
}

function sessionKey(repoId: string, issueNumber: number): string {
  return `${repoId}#${issueNumber}`;
}

const globalRef = globalThis as typeof globalThis & {
  __orchestratorSessions?: SessionsGlobal;
};

function registry(): SessionsGlobal {
  if (!globalRef.__orchestratorSessions) {
    globalRef.__orchestratorSessions = {
      sessions: new Map(),
      listeners: new Set(),
    };
  }
  return globalRef.__orchestratorSessions;
}

function emit(event: SessionEvent): void {
  for (const listener of registry().listeners) {
    try {
      listener(event);
    } catch {
      // A misbehaving listener must not break the session loop.
    }
  }
}

// ---------------------------------------------------------------------------
// Log helpers — text is always tool names, file paths, commands, or one-line
// results. Never file contents or diffs.
// ---------------------------------------------------------------------------

function oneLine(text: string, max = 200): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeLog(kind: LogEvent['kind'], text: string): LogEvent {
  return { ts: new Date().toISOString(), kind, text };
}

const PR_URL_PATTERN =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/;

function scanForPrUrl(live: LiveSession, text: string): void {
  const match = PR_URL_PATTERN.exec(text);
  if (match) {
    live.prUrl = match[0];
    live.prNumber = Number(match[1]);
  }
}

// ---------------------------------------------------------------------------
// Permissions: Hydra decides NOTHING. The repo's own .claude/settings.json
// deny/allow rules (loaded via settingSources: ['project']) are evaluated by
// the SDK before this callback ever runs — a repo deny rule blocks the call
// outright. Whatever the repo's rules leave undecided is auto-approved here so
// a headless session never hangs waiting for an interactive prompt.
// ---------------------------------------------------------------------------

const autoApprove: CanUseTool = async (_toolName, input) => ({
  behavior: 'allow',
  updatedInput: input,
});

// ---------------------------------------------------------------------------
// SDK message → LogEvent mapping
// ---------------------------------------------------------------------------

/**
 * Last-resort model for implementation sessions. Every real start path resolves
 * it first (ticket override → repo's Execution setting, in loop.ts's claim()),
 * so this only applies to a startSession call that passes none.
 */
const EXECUTION_MODEL = DEFAULT_EXECUTION_MODEL;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TEST_COMMAND_PATTERN =
  /\b(test|tests|lint|ruff|eslint|pytest|vitest|jest|tsc|typecheck)\b/;
/**
 * A `git commit` in any spelling — used to log commits AND to gate them behind
 * the review requirement. Tolerates `git -C dir commit` and compound commands;
 * the `(?!-)` skips maintenance subcommands like `git commit-graph`/`commit-tree`.
 */
const GIT_COMMIT_PATTERN = /\bgit\b[^&|;\n]*\bcommit\b(?!-)/;

function logForToolUse(
  name: string,
  input: Record<string, unknown>
): LogEvent | null {
  if (name === 'mcp__orchestrator__ask_user') {
    return null; // the ask_user handler emits its own log events
  }
  if (name === 'Bash') {
    const command = oneLine(typeof input.command === 'string' ? input.command : '');
    let kind: LogEvent['kind'] = 'tool';
    if (GIT_COMMIT_PATTERN.test(command)) kind = 'commit';
    else if (TEST_COMMAND_PATTERN.test(command)) kind = 'test';
    return makeLog(kind, `Bash: ${command}`);
  }
  const summary =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.pattern === 'string'
        ? input.pattern
        : typeof input.query === 'string'
          ? input.query
          : '';
  const kind: LogEvent['kind'] = EDIT_TOOLS.has(name) ? 'edit' : 'tool';
  return makeLog(kind, summary ? `${name}: ${oneLine(summary)}` : name);
}

function collectTextFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: string }).text === 'string'
          ? (block as { text: string }).text
          : ''
      )
      .join('\n');
  }
  return '';
}

function handleMessage(live: LiveSession, message: SDKMessage): void {
  const { repo, issueNumber } = live;

  switch (message.type) {
    case 'system': {
      if (message.subtype === 'init') {
        emit({
          repo,
          issueNumber,
          log: makeLog('info', `Session started (model: ${message.model})`),
          patch: { model: message.model },
        });
      }
      break;
    }

    case 'assistant': {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          scanForPrUrl(live, block.text);
          const text = oneLine(block.text);
          if (text) emit({ repo, issueNumber, log: makeLog('info', text) });
        } else if (block.type === 'tool_use') {
          const log = logForToolUse(
            block.name,
            (block.input ?? {}) as Record<string, unknown>
          );
          if (log) emit({ repo, issueNumber, log });
        }
      }
      break;
    }

    case 'user': {
      // Tool results come back as user messages. Scan for the PR URL (e.g.
      // `gh pr create` output) and surface one-line tool errors — never bodies.
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as { type?: string }).type === 'tool_result'
          ) {
            const toolResult = block as {
              content?: unknown;
              is_error?: boolean;
            };
            const text = collectTextFromToolResultContent(toolResult.content);
            scanForPrUrl(live, text);
            if (toolResult.is_error) {
              emit({
                repo,
                issueNumber,
                log: makeLog('error', `Tool failed: ${oneLine(text)}`),
              });
            }
          }
        }
      }
      break;
    }

    case 'result': {
      const patch: Partial<Task> = {
        turns: message.num_turns,
        costUsd: message.total_cost_usd,
      };
      // Build the neutral outcome; the owning flow decides what it MEANS.
      let outcome: SessionOutcome;
      if (message.subtype === 'success' && !message.is_error) {
        scanForPrUrl(live, message.result);
        outcome = {
          success: true,
          ...(live.prUrl ? { prUrl: live.prUrl, prNumber: live.prNumber } : {}),
        };
      } else {
        const errorText =
          message.subtype === 'success'
            ? oneLine(message.result, 500)
            : oneLine(
                [message.subtype, ...(message.errors ?? [])].join(': '),
                500
              );
        outcome = { success: false, errorText };
      }
      const mapping = live.mapOutcome(outcome);
      Object.assign(patch, mapping.patch);
      const log = makeLog(mapping.logKind, mapping.logText);

      emit({ repo, issueNumber, log, patch });
      // The turn is over and the task is terminal (pr_open/committed/failed).
      // In streaming-input mode the query stays open for more input, so close
      // it explicitly — otherwise the registry entry lingers and Start/Retry
      // fails with "a session is already running".
      live.input.end();
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Everything the runtime needs to launch one session — supplied by a flow. */
export interface StartSessionOptions {
  repo: RepoInfo;
  issueNumber: number;
  worktreePath: string;
  branch: string;
  /** Model id; falls back to the app default when absent. */
  model?: string;
  /** The finished task prompt, built by the owning flow. */
  taskPrompt: string;
  /** The owning flow's mapping of the session's end to task status + log. */
  mapOutcome: OutcomeMapper;
  /** Launch log line (flow-specific wording). */
  launchLog: string;
}

/**
 * Launch one agent session inside its worktree. Resolves once the session is
 * running (fire-and-forget). Flow-agnostic: callers are the flow modules
 * (src/server/flows/*), which supply the prompt and the outcome mapping.
 */
export async function startSession(options: StartSessionOptions): Promise<void> {
  const { repo, issueNumber, worktreePath, branch, model, taskPrompt, mapOutcome, launchLog } =
    options;
  const { sessions } = registry();
  const key = sessionKey(repo.id, issueNumber);
  if (sessions.has(key)) {
    throw new Error(`A session for issue #${issueNumber} is already running`);
  }

  const input = createInputQueue();
  input.push({
    type: 'user',
    message: {
      role: 'user',
      content: taskPrompt,
    },
    parent_tool_use_id: null,
  });

  const askUserServer = createSdkMcpServer({
    name: 'orchestrator',
    version: '1.0.0',
    tools: [
      tool(
        'ask_user',
        ASK_USER_TOOL_DESCRIPTION,
        {
          question: z.string().describe(ASK_USER_QUESTION_DESCRIPTION),
        },
        async ({ question }) => {
          const live = sessions.get(key);
          if (!live || live.stopped) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'The session is no longer active; proceed with your best judgment.',
                },
              ],
            };
          }
          emit({
            repo,
            issueNumber,
            log: makeLog('question', oneLine(question, 500)),
            patch: { status: 'needs_input', question },
          });
          const answer = await new Promise<string>((resolve) => {
            live.pendingReply = resolve;
          });
          emit({
            repo,
            issueNumber,
            log: makeLog('prompt', `Developer reply: ${oneLine(answer, 500)}`),
            patch: { status: 'working', question: undefined },
          });
          return { content: [{ type: 'text', text: answer }] };
        }
      ),
    ],
  });

  const q = query({
    prompt: input.iterable,
    options: {
      cwd: worktreePath,
      // Implementation defaults to Opus (per-task dropdown can override);
      // planning (PE/PM personas) runs on Fable.
      model: model ?? EXECUTION_MODEL,
      // No interactive prompts: edits auto-accepted, everything the repo's own
      // permission rules don't decide is auto-approved (policy lives in the repo).
      permissionMode: 'acceptEdits',
      canUseTool: autoApprove,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Repo rules only: the worktree's CLAUDE.md, .claude/settings.json, and
      // skills — never the developer's user-level settings (deterministic
      // behavior across machines).
      settingSources: ['project'],
      mcpServers: { orchestrator: askUserServer },
      allowedTools: ['mcp__orchestrator__ask_user'],
      persistSession: false,
    },
  });

  const live: LiveSession = {
    repo,
    issueNumber,
    query: q,
    input,
    pendingReply: null,
    stopped: false,
    mapOutcome,
  };
  sessions.set(key, live);

  emit({
    repo,
    issueNumber,
    log: makeLog('info', launchLog),
    patch: {
      status: 'working',
      worktreePath,
      branch,
      startedAt: new Date().toISOString(),
      prompt: taskPrompt,
    },
  });
  // Also in the chronological log — the developer's request, highlighted.
  emit({ repo, issueNumber, log: makeLog('prompt', taskPrompt) });

  void (async () => {
    try {
      for await (const message of q) {
        handleMessage(live, message);
      }
    } catch (error) {
      if (!live.stopped) {
        const text = oneLine(
          error instanceof Error ? error.message : String(error),
          500
        );
        emit({
          repo,
          issueNumber,
          log: makeLog('error', `Session crashed: ${text}`),
          patch: { status: 'failed', error: text },
        });
      }
    } finally {
      live.input.end();
      if (sessions.get(key) === live) {
        sessions.delete(key);
      }
    }
  })();
}

/** Abort a running (or paused) session and release its slot. */
export async function stopSession(
  repo: RepoInfo,
  issueNumber: number
): Promise<void> {
  const { sessions } = registry();
  const key = sessionKey(repo.id, issueNumber);
  const live = sessions.get(key);
  if (!live) return;

  live.stopped = true;
  if (live.pendingReply) {
    const resolve = live.pendingReply;
    live.pendingReply = null;
    resolve('The session was stopped before an answer arrived.');
  }
  try {
    live.query.close();
  } catch {
    // Already terminated — nothing to clean up.
  }
  live.input.end();
  sessions.delete(key);
  emit({ repo, issueNumber, log: makeLog('info', 'Session stopped') });
}

/** Deliver the user's one-turn reply to a session paused in 'needs_input'; resumes it with full context. */
export async function replySession(
  repo: RepoInfo,
  issueNumber: number,
  message: string
): Promise<void> {
  const live = registry().sessions.get(sessionKey(repo.id, issueNumber));
  if (!live) {
    throw new Error(`No running session for issue #${issueNumber}`);
  }
  if (!live.pendingReply) {
    throw new Error(
      `Session for issue #${issueNumber} is not waiting for a reply`
    );
  }
  const resolve = live.pendingReply;
  live.pendingReply = null;
  resolve(message);
}

/** Subscribe to events from ALL sessions (the loop wires this into state.ts). Returns an unsubscribe function. */
export function onSessionEvent(listener: SessionEventListener): () => void {
  const { listeners } = registry();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
