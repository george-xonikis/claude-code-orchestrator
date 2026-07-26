import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { RepoInfo } from '@/lib/types';
import { listRepoAgents } from '@/server/core/agents';
import { readPromptTemplate } from '@/server/knowledge/prompt-templates';
import {
  getPlanningConfig,
  setProductMapRun,
} from '@/server/planning/planning';
import { buildProductMapPrompt } from '@/server/planning/prompts';

/**
 * Product-map bootstrap — a fire-and-forget session that explores the repo and
 * writes docs/product-map.md (left uncommitted for developer review), sparing
 * planning agents a full re-scan on every pass.
 *
 * Optional feature: only available when a brief-maintainer agent is assigned
 * in the planning config (briefAgent, Settings → Agents) — that agent's own
 * `.md` body carries the voice/format instructions; Hydra only supplies the
 * envelope (prompts/product-map.ts). Unlike planning passes this session MAY
 * edit files (permissionMode acceptEdits, allow-all canUseTool) — it needs to
 * write exactly one file. Run state persists as `productMapRun` in the
 * planning store; an in-memory per-repo guard prevents concurrent runs.
 */

const globalRef = globalThis as typeof globalThis & {
  __orchestratorProductMap?: Set<string>;
};

function runningRepos(): Set<string> {
  globalRef.__orchestratorProductMap ??= new Set();
  return globalRef.__orchestratorProductMap;
}

/** True while a bootstrap session is in flight for this repo (backs the 409). */
export function isProductMapRunning(repo: RepoInfo): boolean {
  return runningRepos().has(repo.id);
}

/** The session writes files by design; the repo's own settings still apply. */
const allowAllCanUseTool: CanUseTool = async (_toolName, input) => ({
  behavior: 'allow',
  updatedInput: input,
});

async function runBootstrapQuery(
  repoPath: string,
  prompt: string,
  model: string
): Promise<void> {
  const q = query({
    prompt,
    options: {
      cwd: repoPath,
      model,
      permissionMode: 'acceptEdits',
      canUseTool: allowAllCanUseTool,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Repo rules only — never the developer's user-level settings.
      settingSources: ['project'],
      persistSession: false,
    },
  });
  for await (const message of q) {
    if (message.type === 'result') {
      if (message.subtype !== 'success' || message.is_error) {
        const detail =
          message.subtype === 'success'
            ? message.result
            : [message.subtype, ...('errors' in message ? (message.errors ?? []) : [])].join(': ');
        throw new Error(`product-map session failed: ${detail}`.slice(0, 500));
      }
    }
  }
}

/**
 * Start the product-map bootstrap for a repo. Validates the briefAgent
 * assignment and resolves its definition synchronously (so callers get a clear
 * error), then runs the session fire-and-forget, persisting the outcome as
 * `productMapRun` in the planning store.
 */
export async function runProductMapBootstrap(repo: RepoInfo): Promise<void> {
  const running = runningRepos();
  if (running.has(repo.id)) {
    throw new Error('A product-map bootstrap is already running for this repository');
  }
  const config = await getPlanningConfig(repo);
  if (!config.briefAgent) {
    throw new Error(
      'Assign the product-brief planning agent in Settings → Agents before bootstrapping the product map'
    );
  }
  const agent = (await listRepoAgents(repo.path)).find(
    (a) => a.name.toLowerCase() === config.briefAgent!.toLowerCase()
  );
  if (!agent) {
    throw new Error(`Product-brief agent "${config.briefAgent}" not found in ${repo.name}`);
  }
  const raw = await fsp.readFile(path.join(repo.path, '.claude', 'agents', agent.file), 'utf8');
  const body = raw.replace(/^---[\s\S]*?---\s*/, '');
  const prompt = buildProductMapPrompt(body, await readPromptTemplate('product-map'));

  running.add(repo.id);
  await setProductMapRun(repo.path, { status: 'running' });

  void (async () => {
    try {
      await runBootstrapQuery(repo.path, prompt, config.planningModel);
      await setProductMapRun(repo.path, {
        status: 'done',
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      await setProductMapRun(repo.path, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
    } finally {
      running.delete(repo.id);
    }
  })();
}
