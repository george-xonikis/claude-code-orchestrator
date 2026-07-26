import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentMeta, SkillMeta } from '@/lib/types';

/**
 * Discovery of a managed repo's capabilities: its invocable subagents
 * (`.claude/agents/*.md`) and its skills (`.claude/skills/<dir>/SKILL.md`).
 * Both are referenced in the implementation-session prompt so agents use the
 * repo's own codified procedures instead of improvising — Hydra only surfaces
 * them, it never enforces anything.
 *
 * A subagent's frontmatter `name` is the exact string the execution agent
 * passes as `subagent_type` to the built-in Task tool.
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
 * List the repo's skills by scanning .claude/skills/<dir>/SKILL.md and parsing
 * each file's frontmatter. `name` falls back to the directory name when the
 * frontmatter omits it. Sorted by name; [] if the directory is missing.
 */
export async function listRepoSkills(repoPath: string): Promise<SkillMeta[]> {
  const dir = path.join(repoPath, '.claude', 'skills');
  let entries: string[];
  try {
    entries = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const parsed = await Promise.all(
    entries.map(async (skillDir): Promise<SkillMeta | null> => {
      const raw = await fsp
        .readFile(path.join(dir, skillDir, 'SKILL.md'), 'utf8')
        .catch(() => null);
      if (raw === null) return null;
      const fm = parseAgentFrontmatter(raw);
      const full = (fm.description ?? '').trim();
      const description = full.length > 160 ? `${full.slice(0, 157)}…` : full;
      return { name: (fm.name ?? '').trim() || skillDir, description, dir: skillDir };
    })
  );
  return parsed
    .filter((skill): skill is SkillMeta => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
