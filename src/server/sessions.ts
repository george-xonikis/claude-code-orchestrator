import path from 'node:path';
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
import type { LogEvent, RepoInfo, Task } from '@/lib/types';
import {
  ASK_USER_QUESTION_DESCRIPTION,
  ASK_USER_TOOL_DESCRIPTION,
  buildPrompt,
  SAVE_MEMORY_LESSON_DESCRIPTION,
  SAVE_MEMORY_TOOL_DESCRIPTION,
} from './prompts';
import { appendMemory, readSettings } from './settings';

/**
 * Agent session runtime, backed by the TypeScript Claude Agent SDK
 * (@anthropic-ai/claude-agent-sdk).
 *
 * Sessions are fire-and-forget but may ask ONE-turn questions: the session pauses
 * (task status 'needs_input') until replySession() delivers the user's answer, then
 * resumes with full context. Agents run lint + unit tests only (never e2e, never
 * migrations); `gh pr create` is allowed; deploy/prod commands are denied.
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

/**
 * The pre-commit review gate for one session. `required` is the configured
 * reviewer subagent names (lowercased); `seen` are the ones actually invoked
 * via the Task tool this session. `git commit` is denied until seen ⊇ required.
 * Empty `required` = no gate.
 */
interface ReviewGate {
  required: Set<string>;
  seen: Set<string>;
}

interface LiveSession {
  repo: RepoInfo;
  issueNumber: number;
  query: Query;
  input: InputQueue;
  /** Resolver for a pending ask_user tool call; non-null while status is needs_input. */
  pendingReply: ((answer: string) => void) | null;
  stopped: boolean;
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
// Permission policy: allow everything programmatically (no interactive
// prompts), but deny deploy/prod Bash commands, credential reads, and
// non-GitHub network egress with a refusal message the agent can recover from.
// ---------------------------------------------------------------------------

const DENIED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bterraform\b/, reason: 'terraform commands' },
  { pattern: /\baws\s/, reason: 'aws CLI commands' },
  { pattern: /db-migrate-prod/, reason: 'production database migrations' },
  // Prod DB access: any RDS endpoint, or psql pointed at a non-local host.
  { pattern: /rds\.amazonaws\.com/, reason: 'production (RDS) database connections' },
  {
    pattern: /\bpsql\b[^&|;\n]*\s(-h|--host)[=\s]*(?!(localhost|127\.0\.0\.1)\b)\S+/,
    reason: 'psql connections to remote hosts',
  },
  { pattern: /\bdocker\s+push\b/, reason: 'docker push' },
  // Workflow dispatch/re-run in every gh spelling, not just `gh workflow run`.
  { pattern: /\bgh\s+workflow\s+run\b/, reason: 'workflow dispatch' },
  {
    pattern: /\bgh\s+api\b[^&|;\n]*\bdispatches\b/,
    reason: 'workflow dispatch via gh api',
  },
  { pattern: /\bgh\s+run\s+rerun\b/, reason: 'workflow re-runs' },
  // ALL git pushes: agents commit locally only; the developer pushes from the
  // dashboard. Tolerates intervening args (`git -C dir push`).
  {
    pattern: /\bgit\b[^&|;\n]*\bpush\b/,
    reason: 'git push (the developer pushes from the dashboard)',
  },
  { pattern: /\bgh\s+pr\s+create\b/, reason: 'gh pr create (the developer opens the PR from the dashboard)' },
  // Force pushes: tolerate intervening args (`git -C dir push`), and catch the
  // `+refspec` form which forces without any --force/-f flag.
  {
    pattern:
      /\bgit\b[^&|;\n]*\bpush\b[^&|;\n]*(\s(--force(-with-lease)?|-f)\b|\s\+\S)/,
    reason: 'force pushes',
  },
  // Home-directory credential/config files (~/.aws, ~/.ssh, gh/claude tokens…).
  {
    pattern:
      /(~|\$HOME\b|\$\{HOME\}|\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+)\/\.(aws|ssh|netrc|gnupg|npmrc|docker|kube|config|claude)\b/,
    reason: 'reads of home-directory credential files',
  },
  // Relative-path escapes to .env files (absolute paths handled per-session).
  { pattern: /\.\.\/[^\s"'`;|&]*\.env/, reason: 'reads of .env files outside the worktree' },
];

const GITHUB_HOST_PATTERN = /^([\w-]+\.)*(github\.com|githubusercontent\.com)$/;

/** Deny curl/wget unless every URL is an explicit GitHub host (no URL at all = deny: could be hidden in a variable). */
function deniedNetworkReason(command: string): string | null {
  if (!/\b(curl|wget)\b/.test(command)) return null;
  const urls = command.match(/https?:\/\/[^\s"'`]+/g) ?? [];
  if (urls.length === 0) {
    return 'curl/wget commands without an explicit GitHub URL';
  }
  for (const url of urls) {
    let host: string | null = null;
    try {
      host = new URL(url).hostname;
    } catch {
      host = null;
    }
    if (!host || !GITHUB_HOST_PATTERN.test(host)) {
      return 'curl/wget requests to non-GitHub hosts';
    }
  }
  return null;
}

/** Deny any absolute path to a .env* file that is not inside the worktree (repo-root .env.local holds real keys). */
function deniedEnvPathReason(
  command: string,
  worktreePath: string
): string | null {
  const refs = command.match(/\/[^\s"'`;|&)]*\.env[\w.-]*/g) ?? [];
  for (const ref of refs) {
    if (!ref.startsWith(worktreePath + path.sep)) {
      return 'reads of .env files outside the worktree';
    }
  }
  return null;
}

function deniedBashReason(command: string, worktreePath: string): string | null {
  const denied = DENIED_BASH_PATTERNS.find((d) => d.pattern.test(command));
  if (denied) return denied.reason;
  return (
    deniedNetworkReason(command) ?? deniedEnvPathReason(command, worktreePath)
  );
}

/** Tools that take a filesystem path we can confine to the worktree. */
const FILE_PATH_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
]);

function isOutsideWorktree(rawPath: string, worktreePath: string): boolean {
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(worktreePath, rawPath);
  return resolved !== worktreePath && !resolved.startsWith(worktreePath + path.sep);
}

function makeCanUseTool(
  repo: RepoInfo,
  issueNumber: number,
  worktreePath: string,
  gate: ReviewGate
): CanUseTool {
  return async (toolName, input) => {
    const deny = (reason: string, detail: string) => {
      emit({ repo, issueNumber, log: makeLog('error', `Denied ${detail}`) });
      return {
        behavior: 'deny' as const,
        message: `This was blocked by the orchestrator: ${reason} are not allowed in agent sessions. Do not retry it — continue the task without it.`,
      };
    };

    // Record reviewer subagent invocations toward the pre-commit gate (allow all Task calls).
    if (toolName === 'Task') {
      const sub =
        typeof input.subagent_type === 'string' ? input.subagent_type.trim().toLowerCase() : '';
      if (sub && gate.required.has(sub)) gate.seen.add(sub);
      return { behavior: 'allow', updatedInput: input };
    }

    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';

      // Hard gate: block `git commit` until every configured reviewer has run.
      // NOTE: a bespoke message (not deny()) — we WANT a retry after reviewing.
      if (gate.required.size > 0 && GIT_COMMIT_PATTERN.test(command)) {
        const missing = [...gate.required].filter((name) => !gate.seen.has(name));
        if (missing.length > 0) {
          emit({
            repo,
            issueNumber,
            log: makeLog('error', `Blocked git commit — reviews pending: ${missing.join(', ')}`),
          });
          return {
            behavior: 'deny',
            message:
              `Blocked by the orchestrator: mandatory code review is not complete. ` +
              `Run the ${missing.map((m) => `"${m}"`).join(' and ')} review${
                missing.length === 1 ? '' : 's'
              } first via the Task tool (subagent_type = the agent name), apply the findings, ` +
              `then retry the commit. This is required — do not work around it.`,
          };
        }
      }

      const reason = deniedBashReason(command, worktreePath);
      if (reason) return deny(reason, `command: ${oneLine(command)}`);
    } else if (FILE_PATH_TOOLS.has(toolName)) {
      const rawPath = [input.file_path, input.path, input.notebook_path].find(
        (value): value is string => typeof value === 'string'
      );
      if (rawPath && isOutsideWorktree(rawPath, worktreePath)) {
        return deny(
          'file accesses outside the worktree',
          `${toolName} outside worktree: ${oneLine(rawPath)}`
        );
      }
    } else if (toolName === 'WebFetch') {
      // Same egress rule as curl/wget: GitHub hosts only.
      const url = typeof input.url === 'string' ? input.url : '';
      let host: string | null = null;
      try {
        host = new URL(url).hostname;
      } catch {
        host = null;
      }
      if (!host || !GITHUB_HOST_PATTERN.test(host)) {
        return deny(
          'web fetches to non-GitHub hosts',
          `WebFetch: ${oneLine(url)}`
        );
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

// ---------------------------------------------------------------------------
// SDK message → LogEvent mapping
// ---------------------------------------------------------------------------

/** Model for implementation sessions (planning personas run on Fable in planning.ts). */
const EXECUTION_MODEL = 'claude-opus-4-8';

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
  if (name === 'mcp__orchestrator__ask_user' || name === 'mcp__orchestrator__save_memory') {
    return null; // these tool handlers emit their own log events
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
      let log: LogEvent;

      if (message.subtype === 'success' && !message.is_error) {
        scanForPrUrl(live, message.result);
        if (live.prUrl) {
          patch.status = 'pr_open';
          patch.prUrl = live.prUrl;
          patch.prNumber = live.prNumber;
          log = makeLog('result', `PR opened: ${live.prUrl}`);
        } else {
          // Agents never push — a clean finish means the work is committed in
          // the worktree, awaiting the developer's push from the dashboard.
          patch.status = 'committed';
          log = makeLog('result', 'Work committed locally — push & open the PR from the dashboard');
        }
      } else {
        const errorText =
          message.subtype === 'success'
            ? oneLine(message.result, 500)
            : oneLine(
                [message.subtype, ...(message.errors ?? [])].join(': '),
                500
              );
        patch.status = 'failed';
        patch.error = errorText;
        log = makeLog('error', `Session failed: ${errorText}`);
      }

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

/** Start an agent session for an issue inside its worktree. Resolves once the session is launched (fire-and-forget). */
export async function startSession(
  repo: RepoInfo,
  issueNumber: number,
  worktreePath: string,
  branch: string,
  model?: string,
  useWorkflow = false,
  reviewerAgents: string[] = []
): Promise<void> {
  const { sessions } = registry();
  const key = sessionKey(repo.id, issueNumber);
  if (sessions.has(key)) {
    throw new Error(`A session for issue #${issueNumber} is already running`);
  }

  const input = createInputQueue();
  const { goal, memory } = await readSettings(repo.path);
  const gate: ReviewGate = {
    required: new Set(reviewerAgents.map((name) => name.trim().toLowerCase())),
    seen: new Set<string>(),
  };
  const taskPrompt = buildPrompt(
    issueNumber,
    worktreePath,
    branch,
    goal,
    memory,
    useWorkflow,
    reviewerAgents
  );
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
      tool(
        'save_memory',
        SAVE_MEMORY_TOOL_DESCRIPTION,
        {
          lesson: z.string().describe(SAVE_MEMORY_LESSON_DESCRIPTION),
        },
        async ({ lesson }) => {
          await appendMemory(repo.path, issueNumber, lesson);
          emit({
            repo,
            issueNumber,
            log: makeLog('info', `Memory saved: ${oneLine(lesson, 200)}`),
          });
          return { content: [{ type: 'text', text: 'Lesson saved to shared memory.' }] };
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
      // No interactive prompts: edits auto-accepted, everything else decided
      // programmatically by canUseTool (allow-all except the deny patterns).
      permissionMode: 'acceptEdits',
      canUseTool: makeCanUseTool(repo, issueNumber, worktreePath, gate),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      mcpServers: { orchestrator: askUserServer },
      allowedTools: ['mcp__orchestrator__ask_user', 'mcp__orchestrator__save_memory'],
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
  };
  sessions.set(key, live);

  emit({
    repo,
    issueNumber,
    log: makeLog('info', `Agent session launched on ${branch}`),
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
