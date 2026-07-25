'use client';

import { useEffect, useState } from 'react';
import { Bot, ClipboardList, Info, SlidersHorizontal, Target, Users, X } from 'lucide-react';

import { MODEL_OPTIONS } from '@/lib/models';
import type { AgentMeta } from '@/lib/types';
import { EFFORT_METER, GradeMeterInput, IMPACT_METER } from '@/components/shared/grade-meter';
import { MarkdownEditorSection } from '@/components/shared/markdown-editor-section';
import { Switch } from '@/components/shared/switch';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import {
  type ExecutionConfig,
  getExecutionConfig,
  getPlanningConfig,
  getRepoAgents,
  getSettings,
  MAX_PLANNING_TOPICS,
  type PlanningConfig,
  type PlanningRole,
  saveSettings,
  setExecutionConfig,
  setPlanningConfig,
} from '@/components/shared/task-actions';
import { useRepo } from '@/components/shared/use-repo';

const INTERVAL_OPTIONS = [
  { value: '', label: 'Off (manual only)' },
  { value: '1', label: 'Every hour' },
  { value: '2', label: 'Every 2 hours' },
  { value: '4', label: 'Every 4 hours' },
  { value: '8', label: 'Every 8 hours' },
  { value: '24', label: 'Every 24 hours' },
] as const;

const AGENT_LABEL: Record<PlanningRole, string> = {
  engineer: 'Principal Engineer',
  pm: 'Product Manager',
};

const SELECT_CLASS =
  'h-8 rounded-md border border-border bg-elevated-secondary px-2 text-xs font-medium outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50 disabled:opacity-50';

const TABS = [
  {
    value: 'agents',
    label: 'Agents',
    Icon: Users,
    description: "Assign this repo's agents to each role: planning, review, and the product brief. Pick from this repo's agents (under .claude/agents/).",
  },
  {
    value: 'planning',
    label: 'Planning',
    Icon: ClipboardList,
    description: 'How planning passes run — when they run and what they prioritize.',
  },
  {
    value: 'execution',
    label: 'Execution',
    Icon: Bot,
    description: 'How agent sessions run — auto-pickup and concurrency.',
  },
  {
    value: 'goal',
    label: 'Goal',
    Icon: Target,
    description: 'The north star injected into planning and every agent session.',
  },
  {
    value: 'preferences',
    label: 'Preferences',
    Icon: SlidersHorizontal,
    description: 'Local appearance settings for this browser.',
  },
] as const;

type Tab = (typeof TABS)[number]['value'];

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-h-8 items-center justify-between gap-4">
      <span className="text-sm font-medium">
        {label}
        {hint && <span className="ml-1 text-muted-foreground">— {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function NumberSelect({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const options: number[] = [];
  for (let n = min; n <= max; n++) options.push(n);
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} className={SELECT_CLASS}>
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}

/** Single-agent picker from the repo's .claude/agents/. Shows a "missing" option if the saved name is gone. */
function AgentSelect({
  value,
  agents,
  onChange,
  defaultLabel,
}: {
  value: string | null;
  agents: AgentMeta[];
  onChange: (value: string | null) => void;
  defaultLabel: string;
}) {
  const missing = value !== null && !agents.some((a) => a.name === value);
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className={SELECT_CLASS}
    >
      <option value="">{defaultLabel}</option>
      {agents.map((a) => (
        <option key={a.name} value={a.name}>
          {a.name}
        </option>
      ))}
      {missing && <option value={value ?? ''}>{value} (missing)</option>}
    </select>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 py-6">
      <div>
        <h2 className="text-base font-medium text-foreground">{title}</h2>
        {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  // Layout: Nous-style settings — flat field groups (space-y-6 between, space-y-3 within).
  const { current, loaded: reposLoaded } = useRepo();
  const repoId = current?.id ?? null;
  const [cfg, setCfg] = useState<PlanningConfig | null>(null);
  const [ecfg, setEcfg] = useState<ExecutionConfig | null>(null);
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [goal, setGoal] = useState('');
  const [memory, setMemory] = useState('');
  const [planningMemory, setPlanningMemory] = useState('');
  const [topicDraft, setTopicDraft] = useState('');
  const [tab, setTab] = useState<Tab>('agents');

  // Reset during render when the repo changes (derived-state pattern).
  const [loadedRepoId, setLoadedRepoId] = useState(repoId);
  if (loadedRepoId !== repoId) {
    setLoadedRepoId(repoId);
    setCfg(null);
    setEcfg(null);
    setAgents([]);
    setGoal('');
    setMemory('');
    setPlanningMemory('');
    setTopicDraft('');
  }

  useEffect(() => {
    if (!repoId) return;
    getPlanningConfig(repoId).then(setCfg).catch(() => {});
    getExecutionConfig(repoId).then(setEcfg).catch(() => {});
    getRepoAgents(repoId).then(setAgents).catch(() => {});
    getSettings(repoId)
      .then((s) => {
        setGoal(s.goal);
        setMemory(s.memory);
        setPlanningMemory(s.planningMemory);
      })
      .catch(() => {});
  }, [repoId]);

  /** Optimistically apply a planning-config patch and persist it (server echoes the sanitized config). */
  const patch = (p: Partial<PlanningConfig>) => {
    if (!repoId) return;
    setCfg((prev) => (prev ? { ...prev, ...p } : prev));
    setPlanningConfig(repoId, p)
      .then(setCfg)
      .catch(() => {});
  };

  /** Optimistically apply an execution-config patch and persist it. */
  const patchExec = (p: Partial<ExecutionConfig>) => {
    if (!repoId) return;
    setEcfg((prev) => (prev ? { ...prev, ...p } : prev));
    setExecutionConfig(repoId, p)
      .then(setEcfg)
      .catch(() => {});
  };

  const toggleRole = (role: PlanningRole) => {
    if (!cfg) return;
    const next = cfg.roles.includes(role)
      ? cfg.roles.filter((r) => r !== role)
      : [...cfg.roles, role];
    if (next.length === 0) return; // keep at least one agent
    patch({ roles: next });
  };

  const toggleReviewer = (name: string) => {
    if (!ecfg) return;
    const next = ecfg.reviewerAgents.includes(name)
      ? ecfg.reviewerAgents.filter((r) => r !== name)
      : [...ecfg.reviewerAgents, name]; // empty is valid: no gate
    patchExec({ reviewerAgents: next });
  };

  const addTopic = () => {
    if (!cfg) return;
    const t = topicDraft.trim();
    if (!t || cfg.topics.length >= MAX_PLANNING_TOPICS) return;
    if (cfg.topics.some((x) => x.toLowerCase() === t.toLowerCase())) {
      setTopicDraft('');
      return;
    }
    patch({ topics: [...cfg.topics, t] });
    setTopicDraft('');
  };

  const removeTopic = (topic: string) => {
    if (!cfg) return;
    patch({ topics: cfg.topics.filter((t) => t !== topic) });
  };

  if (reposLoaded && !current) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
        Add a repository on the board to edit its settings.
      </div>
    );
  }

  // Config-backed tabs need their config loaded; Goal/Memory only need their own text.
  const configLoading =
    (tab === 'planning' && !cfg) ||
    (tab === 'execution' && !ecfg) ||
    (tab === 'agents' && (!cfg || !ecfg));

  const activeTab = TABS.find((t) => t.value === tab);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 p-6 sm:p-8">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      <div className="flex flex-col gap-8 sm:flex-row">
        <nav
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings"
          className="flex shrink-0 gap-1 sm:w-56 sm:flex-col sm:border-r sm:border-border sm:pr-6"
        >
          {TABS.map(({ value, label, Icon }) => {
            const active = tab === value;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(value)}
                className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-background-hover hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 divide-y divide-border md:max-w-2xl">
          <header className="pb-5">
            <h2 className="text-2xl font-semibold tracking-tight">{activeTab?.label}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{activeTab?.description}</p>
          </header>

          {configLoading && (
            <p className="text-sm text-muted-foreground">Loading configuration…</p>
          )}

          {tab === 'planning' && cfg && (
            <>
              <Section
                title="Run scope"
                description="Which roles a planning pass runs — used by scheduled auto-runs and manual runs on the Planning page. Who fills each role is set in the Agents tab."
              >
                {(['engineer', 'pm'] as PlanningRole[]).map((role) => (
                  <Row key={role} label={AGENT_LABEL[role]}>
                    <Switch
                      checked={cfg.roles.includes(role)}
                      disabled={cfg.roles.length === 1 && cfg.roles.includes(role)}
                      onChange={() => toggleRole(role)}
                    />
                  </Row>
                ))}
              </Section>

              <Section title="Auto-run">
                <Row label="Schedule" hint="run a pass automatically">
                  <select
                    value={cfg.intervalHours === null ? '' : String(cfg.intervalHours)}
                    onChange={(e) =>
                      patch({
                        intervalHours: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                    className={SELECT_CLASS}
                  >
                    {INTERVAL_OPTIONS.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Row>
              </Section>

              <Section
                title="Auto-file"
                description={
                  <>
                    When on, a scheduled pass opens its top-ranked proposals as GitHub issues
                    (labeled <code className="font-mono text-[11px]">proposed</code>) instead of
                    waiting for you to file them.
                  </>
                }
              >
                <Row label="Auto-file proposals">
                  <Switch checked={cfg.autoFile} onChange={(v) => patch({ autoFile: v })} />
                </Row>
                {cfg.autoFile && (
                  <Row label="Max auto-filed per pass" hint="top-ranked first">
                    <NumberSelect
                      value={cfg.maxAutoFile}
                      min={0}
                      max={9}
                      onChange={(n) => patch({ maxAutoFile: n })}
                    />
                  </Row>
                )}
              </Section>

              <Section title="Proposals">
                <Row label="Max proposals per pass">
                  <NumberSelect
                    value={cfg.maxProposals}
                    min={1}
                    max={15}
                    onChange={(n) => patch({ maxProposals: n })}
                  />
                </Row>
                <Row label="Min impact" hint="drop proposals below">
                  <GradeMeterInput
                    style={IMPACT_METER}
                    value={cfg.minImpact}
                    onChange={(n) => patch({ minImpact: n })}
                  />
                </Row>
                <Row label="Max effort" hint="drop proposals above">
                  <GradeMeterInput
                    style={EFFORT_METER}
                    value={cfg.maxEffort}
                    onChange={(n) => patch({ maxEffort: n })}
                  />
                </Row>
                <div>
                  <div className="text-sm font-medium">
                    Focus topics
                    <span className="ml-1 text-muted-foreground">
                      — up to {MAX_PLANNING_TOPICS} keywords the plan sticks to
                    </span>
                  </div>
                  {cfg.topics.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {cfg.topics.map((topic) => (
                        <span
                          key={topic}
                          className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground"
                        >
                          {topic}
                          <button
                            type="button"
                            onClick={() => removeTopic(topic)}
                            aria-label={`Remove ${topic}`}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {cfg.topics.length < MAX_PLANNING_TOPICS && (
                    <input
                      value={topicDraft}
                      onChange={(e) => setTopicDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          addTopic();
                        }
                      }}
                      onBlur={addTopic}
                      placeholder="Type a topic and press Enter"
                      maxLength={60}
                      className="mt-2 h-8 w-1/2 rounded-md border border-border bg-elevated-secondary px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
                    />
                  )}
                </div>
              </Section>

              <MarkdownEditorSection
                title="Planning memory"
                description="Prioritization guidance the PE/PM personas read every pass — what's worth proposing, and what to avoid. Reasons you give when dismissing proposals are appended here automatically; curate freely. Stored in .orchestrator/planning-memory.md."
                value={planningMemory}
                minHeightClass="min-h-56 max-h-[32rem]"
                placeholder="- We don't propose test-coverage work as features — tracked separately.&#10;- No broad rewrites; prefer incremental, shippable changes."
                onChange={setPlanningMemory}
                onSave={() =>
                  repoId ? saveSettings(repoId, { planningMemory }) : Promise.resolve()
                }
              />
            </>
          )}

          {tab === 'agents' && cfg && ecfg && (
            <>
              <Section
                title="Planning agents"
                description={
                  <>
                    Who fills each planning role.
                  </>
                }
              >
                <Row label="Principal Engineer (PE)">
                  <AgentSelect
                    value={cfg.peAgent}
                    agents={agents}
                    onChange={(v) => patch({ peAgent: v })}
                    defaultLabel="Default (principal-engineer)"
                  />
                </Row>
                <Row label="Product Manager (PM)">
                  <AgentSelect
                    value={cfg.pmAgent}
                    agents={agents}
                    onChange={(v) => patch({ pmAgent: v })}
                    defaultLabel="Default (product-manager)"
                  />
                </Row>
              </Section>

              <Section
                title="Reviewers"
                description={
                  <>
                    Reviewers an execution agent{' '}
                    <span className="font-medium">must run before it may commit</span>.
                  </>
                }
              >
                {ecfg.reviewerAgents.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {ecfg.reviewerAgents.map((name) => {
                      const missing = !agents.some((a) => a.name === name);
                      return (
                        <span
                          key={name}
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                            missing
                              ? 'bg-destructive/10 text-destructive'
                              : 'bg-secondary text-secondary-foreground'
                          }`}
                        >
                          {name}
                          <button
                            type="button"
                            onClick={() => toggleReviewer(name)}
                            aria-label={`Remove ${name}`}
                            className="opacity-70 hover:opacity-100"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
                {agents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No agents found in <code>.claude/agents/</code> for this repo.
                  </p>
                ) : (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) toggleReviewer(e.target.value);
                    }}
                    className={SELECT_CLASS}
                  >
                    <option value="">Add a reviewer…</option>
                    {agents
                      .filter((a) => !ecfg.reviewerAgents.includes(a.name))
                      .map((a) => (
                        <option key={a.name} value={a.name}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                )}
                {ecfg.reviewerAgents.length === 0 ? (
                  <p className="text-xs text-warning">
                    ⚠️ No reviewer selected — commit review is{' '}
                    <span className="font-medium">not enforced</span>.
                  </p>
                ) : (
                  ecfg.reviewerAgents
                    .filter((name) => !agents.some((a) => a.name === name))
                    .map((name) => (
                      <p key={name} className="text-xs text-destructive">
                        ⚠️ <span className="font-medium">{name}</span> — missing from{' '}
                        <code>.claude/agents/</code>; will block sessions until added or deselected.
                      </p>
                    ))
                )}
              </Section>

              <Section
                title="Product brief"
                description="The agent that keeps this repo's product brief up to date"
              >
                <Row label="Brief maintainer">
                  <AgentSelect
                    value={cfg.briefAgent}
                    agents={agents}
                    onChange={(v) => patch({ briefAgent: v })}
                    defaultLabel="None"
                  />
                </Row>
              </Section>
            </>
          )}

          {tab === 'execution' && ecfg && (
            <>
            <Section
              title="Model"
              description="The model agent sessions run on. A ticket can override this from its own settings."
            >
              <Row label="Execution model">
                <select
                  value={ecfg.executionModel}
                  onChange={(e) => patchExec({ executionModel: e.target.value })}
                  className={SELECT_CLASS}
                >
                  {MODEL_OPTIONS.map(({ id, label }) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </Row>
            </Section>
            <Section
              title="Agentic mode (loops)"
              description={
                <div className="flex gap-3 rounded-lg border border-info/30 bg-info-muted/40 p-4 leading-relaxed">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
                  <div className="space-y-1.5">
                    <p>
                      🤖 <span className="font-medium text-foreground">Agentic mode</span> runs open{' '}
                      <span className="font-medium text-foreground">proposed</span> issues on their
                      own:
                    </p>
                    <ul className="space-y-1">
                      <li>⚙️ plan → file → code → commit, then stops there</li>
                      <li>🔒 Pushing &amp; opening the PR stays manual and human-reviewed</li>
                      <li>⏹️ Turning it off clears the queue, but in-progress agents finish</li>
                    </ul>
                    <p>
                      Toggle it <span className="font-medium text-foreground">on or off from the
                      board</span>.
                    </p>
                  </div>
                </div>
              }
            >
              <Row label="Max concurrent agents">
                <NumberSelect
                  value={ecfg.maxActive}
                  min={1}
                  max={5}
                  onChange={(n) => patchExec({ maxActive: n })}
                />
              </Row>
              <Row label="Tasks per run" hint="then auto-pickup stops">
                <select
                  value={ecfg.tasksPerRun === null ? '' : String(ecfg.tasksPerRun)}
                  onChange={(e) =>
                    patchExec({ tasksPerRun: e.target.value === '' ? null : Number(e.target.value) })
                  }
                  className={SELECT_CLASS}
                >
                  {[2, 4, 8, 12, 20].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                  <option value="">Unlimited</option>
                </select>
              </Row>
              <Row label="Queue order" hint="which ticket agents take first">
                <select
                  value={ecfg.queueOrder}
                  onChange={(e) => patchExec({ queueOrder: e.target.value as ExecutionConfig['queueOrder'] })}
                  className={SELECT_CLASS}
                >
                  <option value="oldest">Oldest first</option>
                  <option value="newest">Newest first</option>
                </select>
              </Row>
              <Row label="Poll GitHub every" hint="auto-sync issues to the board">
                <select
                  value={ecfg.pollMinutes === null ? '' : String(ecfg.pollMinutes)}
                  onChange={(e) =>
                    patchExec({ pollMinutes: e.target.value === '' ? null : Number(e.target.value) })
                  }
                  className={SELECT_CLASS}
                >
                  <option value="">Off</option>
                  {[1, 2, 5, 10, 15, 30, 60].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </Row>
            </Section>
            <MarkdownEditorSection
              title="Memory"
              description="Reusable codebase lessons injected into every execution session. Agents append here via save_memory (stamped with the issue number) — curate freely, delete anything wrong. Stored in .orchestrator/memory.md."
              value={memory}
              minHeightClass="min-h-72 max-h-[36rem]"
              placeholder="- [#312] The pre-commit hook requires all modified backend files staged…"
              onChange={setMemory}
              onSave={() => (repoId ? saveSettings(repoId, { memory }) : Promise.resolve())}
            />
            </>
          )}

          {tab === 'goal' && (
            <MarkdownEditorSection
              description="Steers this repo's planning and every agent session — vision, current priorities, what “done well” means. Stored in .orchestrator/goal.md."
              value={goal}
              minHeightClass="min-h-56 max-h-[32rem]"
              placeholder="e.g. Nous is a knowledge platform for SMEs. Current priority: …"
              onChange={setGoal}
              onSave={() => (repoId ? saveSettings(repoId, { goal }) : Promise.resolve())}
            />
          )}

          {tab === 'preferences' && (
            <Section title="Appearance">
              <Row label="Dark mode" hint="applies to this browser">
                <ThemeToggle />
              </Row>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
