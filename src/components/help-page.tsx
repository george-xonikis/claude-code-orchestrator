import { ArrowDown } from 'lucide-react';

/**
 * /help — the app's architecture, from scratch: the six layers Hydra is built
 * from, their dependency direction, and the independence rules. This page is
 * the agreed reference for how the codebase is (to be) structured.
 */

interface Layer {
  name: string;
  tagline: string;
  contains: string[];
  independence: string;
}

const AUTOMATION: Layer = {
  name: 'Loop',
  tagline: 'Pure automation. Nothing depends on it.',
  contains: ['GitHub polling schedule', 'auto-pickup queue', 'restart recovery'],
  independence:
    'Turn it off and everything still works by hand — it only automates the layers below.',
};

const PIPELINES: Layer[] = [
  {
    name: 'Planning',
    tagline: 'Decides WHAT to build. Never implements.',
    contains: ['agents planning (PE/PM)', 'proposal synthesis', 'ad-hoc planning', 'files approved issues'],
    independence: 'Lives without execution — its output is just GitHub issues.',
  },
  {
    name: 'Execution',
    tagline: 'Implements ONE issue per agent session.',
    contains: [
      'session runtime',
      'flows: implementation, conflict, review response (planned)',
      'push & open PR',
    ],
    independence:
      'Lives without planning — any GitHub issue is a valid input. Manual "Start agent" needs no loop.',
  },
];

const FOUNDATIONS: Layer[] = [
  {
    name: 'Core',
    tagline: 'The outside world.',
    contains: [
      'issue provider: GitHub (gh)',
      'GitLab (glab) — planned',
      'git worktrees',
      'repo registry',
      '.claude-hydra data dir',
    ],
    independence:
      'No opinions — plumbing only. The issue provider is an interface: GitHub via gh today, GitLab via glab next. No layer above may care which.',
  },
  {
    name: 'State',
    tagline: 'What the board shows.',
    contains: ['task statuses', 'per-issue logs', 'SSE streams'],
    independence: 'Execution writes, UI reads.',
  },
  {
    name: 'Knowledge & Config',
    tagline: 'Per-repo memory and knobs.',
    contains: ['goal.md', 'planning memory', 'settings', 'prompt template overrides'],
    independence: 'Goal and planning memory feed planning only; settings and prompts feed both.',
  },
];

/** Every LLM call in the app, grouped by owning layer, with each prompt's generic rules. */
const PROMPT_INVENTORY = [
  {
    layer: 'Execution',
    prompts: [
      {
        name: 'Implementation',
        what: 'launches the session that works an issue',
        rules: [
          'States the envelope: issue #, worktree path, branch — where to work',
          'The issue (body + comments) is the full task spec',
          'The repo governs HOW: CLAUDE.md, skills, agents, settings — Hydra adds no rules',
          'Optional — only when the repo has a brief-maintainer agent assigned: update the product map (docs/product-map.md, committed in the repo) before committing',
          'Finish = commit; the dashboard pushes & opens the PR if the agent didn’t',
          'Tool: ask_user (one blocking question)',
        ],
      },
      {
        name: 'Conflict resolution',
        what: 'launches the session that rebases a conflicting PR',
        rules: [
          'States the envelope: PR #, issue #, branch, worktree',
          'Understand both sides first: the PR’s intent and what the default branch changed',
          'Rebase onto the default branch (the repo’s rules may prescribe another method)',
          'Resolve by preserving BOTH intents — never blindly take one side',
          'Finish = clean, verified, fully-completed rebase; the dashboard force-pushes',
          'Tool: ask_user (e.g. when the two sides are genuinely irreconcilable)',
        ],
      },
      {
        name: 'Review response — planned',
        what: 'launches the session that addresses a human PR review',
        rules: [
          'Trigger: the PR gets review comments / changes requested (detected during polls)',
          'States the envelope: PR #, issue #, branch, worktree',
          'The review comments are the task spec — address each one, or reply with reasoning where you disagree',
          'The repo governs HOW, same as Implementation',
          'Finish = commit; the dashboard pushes the update to the PR',
          'Tool: ask_user (when a comment is ambiguous)',
        ],
      },
    ],
  },
  {
    layer: 'Planning',
    prompts: [
      {
        name: 'Agents Planning',
        what: 'wraps the repo’s PE/PM agent definitions into a read-only scan (one wrapper, two agents)',
        rules: [
          'The user assigns the PE and PM agents in Settings → Agents, picked from the repo’s .claude/agents/ list — no defaults; the wrapper defines the run',
          'Read-only — may inspect, never modify or file anything',
          'If the repo maintains a product map: reads it FIRST, scans the code only where it falls short',
          'Inputs: goal, planning memory, exclusions (don’t re-propose), shaping caps — plus the chat direction on ad-hoc passes only',
          'Output: a proposal report for synthesis',
        ],
      },
      {
        name: 'Synthesis',
        what: 'merges the planning agents’ reports into the ranked proposal list',
        rules: [
          'Dedupes and merges the PE + PM reports',
          'Ranks by leverage; respects impact/effort/topic caps and exclusions',
          'Output: strict JSON — title, body, labels, effort, impact per proposal',
        ],
      },
      {
        name: 'Ad-hoc planning',
        what: 'a chat that launches its own focused planning pass',
        rules: [
          'Conversation only — never creates proposals itself',
          'Knows the goal and the current proposal titles',
          'From the chat you launch an ad-hoc pass scoped to that direction',
          'Main/scheduled planning is unaffected — it always runs unsteered',
        ],
      },
      {
        name: 'Proposal discussion',
        what: 'the "Discuss" drawer (can edit/split proposals via tools)',
        rules: [
          'Scoped to ONE proposal; knows the goal',
          'May edit or split it via update_proposal / create_proposal tools',
          'Never files issues — filing stays a human click',
        ],
      },
      {
        name: 'Product map bootstrap',
        what: 'the brief-maintainer agent generates the initial product map for a repo',
        rules: [
          'Optional feature — active only when a brief-maintainer agent is assigned in Settings → Agents',
          'Runs once on demand (or when the map is missing)',
          'Writes docs/product-map.md in the repo — committed, so PRs keep it current',
          'After bootstrap, execution sessions maintain it; planning only reads it',
        ],
      },
    ],
  },
] as const;

function LayerCard({ layer, wide = false }: { layer: Layer; wide?: boolean }) {
  return (
    <div
      className={`rounded-lg border border-border bg-elevated-secondary p-4 ${wide ? 'w-full' : 'flex-1'}`}
    >
      <div className="text-base font-bold">{layer.name}</div>
      <div className="mt-0.5 text-[13px] text-muted-foreground">{layer.tagline}</div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {layer.contains.map((item) => (
          <span
            key={item}
            className="rounded-full bg-main-surface-primary px-2 py-0.5 text-xs text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        {layer.independence}
      </p>
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex justify-center py-1.5 text-muted-foreground">
      <ArrowDown aria-hidden className="h-4 w-4" />
    </div>
  );
}

export function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-bold tracking-tight">How Hydra is structured</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Six layers, one dependency direction: automation on top, pipelines in the middle,
        foundations at the bottom. Arrows mean &ldquo;may depend on&rdquo; — never the reverse.
      </p>

      <div className="mt-8">
        <LayerCard layer={AUTOMATION} wide />
        <Arrow />
        <div className="flex flex-col gap-3 sm:flex-row">
          {PIPELINES.map((layer) => (
            <LayerCard key={layer.name} layer={layer} />
          ))}
        </div>
        <Arrow />
        <div className="flex flex-col gap-3 sm:flex-row">
          {FOUNDATIONS.map((layer) => (
            <LayerCard key={layer.name} layer={layer} />
          ))}
        </div>
      </div>

      <h2 className="mt-10 text-lg font-bold">Prompts</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        All the places Hydra talks to an LLM. Every prompt is editable in Settings → Prompts.
      </p>
      <div className="mt-3 overflow-hidden rounded-lg border border-border">
        {PROMPT_INVENTORY.map((group) => (
          <div key={group.layer} className="border-b border-border last:border-b-0">
            <div className="bg-main-surface-primary px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {group.layer}
            </div>
            <div className="space-y-3 p-3">
              {group.prompts.map((p) => (
                <div key={p.name}>
                  <div className="text-[13px] leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">{p.name}</span> — {p.what}
                  </div>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs leading-relaxed text-muted-foreground">
                    {p.rules.map((rule) => (
                      <li key={rule}>{rule}</li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>


      <h2 className="mt-10 text-lg font-bold">The rules</h2>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Planning and Execution never touch.</span>{' '}
          They meet only through issues (GitHub today, GitLab planned) — plan without implementing,
          implement without a plan.
        </li>
        <li>
          <span className="font-medium text-foreground">The Loop is optional.</span> Everything it
          automates (polling, pickup) can be done manually from the dashboard.
        </li>
        <li>
          <span className="font-medium text-foreground">Policy lives in each managed repo.</span>{' '}
          CLAUDE.md, skills, agents, and permission rules govern the work; Hydra only manages
          sessions.
        </li>
        <li>
          <span className="font-medium text-foreground">
            The user&rsquo;s model and workflow choices always apply.
          </span>{' '}
          Every session — any flow — runs on the ticket&rsquo;s chosen model (else the repo&rsquo;s
          default) and honors the dynamic-workflow toggle.
        </li>
      </ul>
    </div>
  );
}
