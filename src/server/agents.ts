import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentMeta, RepoInfo } from '@/lib/types';

/**
 * Discovery of a managed repo's invocable subagents (its `.claude/agents/*.md`
 * definitions) and the start-time gate that a session's configured reviewer
 * agents actually exist.
 *
 * A subagent's frontmatter `name` is the exact string the execution agent
 * passes as `subagent_type` to the built-in Task tool — so `name` is the one
 * identifier that flows through discovery, config, prompt, and the commit gate
 * (sessions.ts). It is always compared lowercased/trimmed.
 */

/**
 * Pull `name`/`description` out of a leading YAML `--- … ---` frontmatter block.
 * Handles plain/quoted scalars AND block scalars (`description: >` / `|`, common
 * in agent files) by folding their indented continuation lines into one string.
 */
function parseAgentFrontmatter(raw: string): { name?: string; description?: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1] as 'name' | 'description';
    const inline = kv[2].trim();
    if (/^[|>][-+]?$/.test(inline)) {
      // Block scalar: gather the following more-indented lines.
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') { block.push(''); continue; }
        if (!/^\s/.test(lines[j])) break; // dedent → end of block
        block.push(lines[j].trim());
      }
      out[key] = block.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      out[key] = inline.replace(/^["']|["']$/g, '').trim();
    }
  }
  return out;
}

/**
 * List the repo's invocable subagents by scanning .claude/agents/*.md and
 * parsing each file's frontmatter. Only agents that declare a `name` are
 * Task-invocable, so only those are returned. Deduped (by lowercased name)
 * and sorted. Returns [] if the directory is missing.
 */
export async function listRepoAgents(repoPath: string): Promise<AgentMeta[]> {
  const dir = path.join(repoPath, '.claude', 'agents');
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const parsed = await Promise.all(
    files
      .filter((file) => file.endsWith('.md'))
      .map(async (file) => {
        const raw = await fsp.readFile(path.join(dir, file), 'utf8').catch(() => '');
        const fm = parseAgentFrontmatter(raw);
        // Descriptions can be multi-paragraph; keep a short one-line hint.
        const full = (fm.description ?? '').trim();
        const description = full.length > 160 ? `${full.slice(0, 157)}…` : full;
        return { name: (fm.name ?? '').trim(), description, file };
      })
  );
  const seen = new Set<string>();
  return parsed
    .filter((agent) => {
      if (!agent.name) return false;
      const key = agent.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Throw if any configured reviewer agent is missing from the repo (empty list
 * is a no-op). Mirrors planning.ts's requirePersonaFiles — the thrown message
 * is surfaced to the developer via loop.ts's claim() catch.
 */
export async function requireReviewerAgents(
  repo: RepoInfo,
  reviewerNames: string[]
): Promise<void> {
  if (reviewerNames.length === 0) return;
  const have = new Set((await listRepoAgents(repo.path)).map((agent) => agent.name.toLowerCase()));
  const missing = reviewerNames.filter((name) => !have.has(name.trim().toLowerCase()));
  if (missing.length > 0) {
    throw new Error(
      `Reviewer agents missing in ${repo.name}: ${missing.join(', ')} — add them under .claude/agents/ or update Execution settings`
    );
  }
}
