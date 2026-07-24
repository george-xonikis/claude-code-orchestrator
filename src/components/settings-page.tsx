'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { EFFORT_METER, GradeMeterInput, IMPACT_METER } from '@/components/shared/grade-meter';
import { MarkdownEditorSection } from '@/components/shared/markdown-editor-section';
import { Switch } from '@/components/shared/switch';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import {
  getPlanningConfig,
  getSettings,
  MAX_PLANNING_TOPICS,
  type PlanningConfig,
  type PlanningRole,
  saveSettings,
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
  'h-8 rounded-md border border-border bg-main-surface-primary px-2 text-xs font-medium outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50 disabled:opacity-50';

const TABS = [
  { value: 'planning', label: 'Planning' },
  { value: 'execution', label: 'Execution' },
  { value: 'goal', label: 'Goal' },
  { value: 'memory', label: 'Memory' },
  { value: 'preferences', label: 'Preferences' },
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
    <label className="flex min-h-9 items-center justify-between gap-4">
      <span className="text-xs font-medium">
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg bg-elevated-secondary p-6">
      <h2 className="text-sm font-bold">{title}</h2>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const { current, loaded: reposLoaded } = useRepo();
  const repoId = current?.id ?? null;
  const [cfg, setCfg] = useState<PlanningConfig | null>(null);
  const [goal, setGoal] = useState('');
  const [memory, setMemory] = useState('');
  const [topicDraft, setTopicDraft] = useState('');
  const [tab, setTab] = useState<Tab>('planning');

  // Reset during render when the repo changes (derived-state pattern).
  const [loadedRepoId, setLoadedRepoId] = useState(repoId);
  if (loadedRepoId !== repoId) {
    setLoadedRepoId(repoId);
    setCfg(null);
    setGoal('');
    setMemory('');
    setTopicDraft('');
  }

  useEffect(() => {
    if (!repoId) return;
    getPlanningConfig(repoId).then(setCfg).catch(() => {});
    getSettings(repoId)
      .then((s) => {
        setGoal(s.goal);
        setMemory(s.memory);
      })
      .catch(() => {});
  }, [repoId]);

  /** Optimistically apply a config patch and persist it (server echoes the sanitized config). */
  const patch = (p: Partial<PlanningConfig>) => {
    if (!repoId) return;
    setCfg((prev) => (prev ? { ...prev, ...p } : prev));
    setPlanningConfig(repoId, p)
      .then(setCfg)
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

  // Config-backed tabs need cfg; Goal/Memory only need their own text.
  const configLoading = !cfg && (tab === 'planning' || tab === 'execution');

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-sm font-bold">Settings</h1>

      <div className="flex flex-col gap-6 sm:flex-row">
        <nav
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings"
          className="flex shrink-0 gap-1 sm:w-36 sm:flex-col"
        >
          {TABS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`rounded-md px-3 py-2 text-left text-sm font-medium ${
                tab === value
                  ? 'bg-background-hover text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {configLoading && (
            <p className="text-sm text-muted-foreground">Loading configuration…</p>
          )}

          {tab === 'planning' && cfg && (
            <>
              <Section title="Agents">
                <p className="text-xs text-muted-foreground">
                  Which agents planning passes run — used by both scheduled auto-runs and manual
                  runs on the Planning page.
                </p>
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

              <Section title="Auto-file">
                <p className="text-xs text-muted-foreground">
                  When on, a scheduled pass opens its top-ranked proposals as GitHub issues
                  (labeled <code className="font-mono text-[11px]">proposed</code>) instead of
                  waiting for you to file them.
                </p>
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
                  <div className="text-xs font-medium">
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
                      className="mt-2 h-8 w-1/2 rounded-md border border-border bg-main-surface-primary px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
                    />
                  )}
                </div>
              </Section>
            </>
          )}

          {tab === 'execution' && cfg && (
            <Section title="Agentic mode (loops)">
              <div className="text-sm leading-relaxed text-muted-foreground">
                <p>
                  🤖 <span className="font-medium">Agentic mode</span> runs open{' '}
                  <span className="font-medium">proposed</span> issues on their own:
                </p>
                <ul className="mt-1.5 space-y-1">
                  <li>⚙️ plan → file → code → commit, then stops there</li>
                  <li>🔒 Pushing &amp; opening the PR stays manual and human-reviewed</li>
                  <li>⏹️ Turning it off clears the queue, but in-progress agents finish</li>
                </ul>
                <p className="mt-1.5">
                  Toggle it <span className="font-medium">on or off from the board</span>.
                </p>
              </div>
              <Row label="Max concurrent agents">
                <NumberSelect
                  value={cfg.maxActive}
                  min={1}
                  max={5}
                  onChange={(n) => patch({ maxActive: n })}
                />
              </Row>
              <Row label="Tasks per run" hint="then auto-pickup stops">
                <select
                  value={cfg.tasksPerRun === null ? '' : String(cfg.tasksPerRun)}
                  onChange={(e) =>
                    patch({ tasksPerRun: e.target.value === '' ? null : Number(e.target.value) })
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
                  value={cfg.queueOrder}
                  onChange={(e) => patch({ queueOrder: e.target.value as PlanningConfig['queueOrder'] })}
                  className={SELECT_CLASS}
                >
                  <option value="oldest">Oldest first</option>
                  <option value="newest">Newest first</option>
                </select>
              </Row>
              <Row label="Poll GitHub every" hint="auto-sync issues to the board">
                <select
                  value={cfg.pollMinutes === null ? '' : String(cfg.pollMinutes)}
                  onChange={(e) =>
                    patch({ pollMinutes: e.target.value === '' ? null : Number(e.target.value) })
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
          )}

          {tab === 'goal' && (
            <MarkdownEditorSection
              title="Goal"
              description="Steers this repo's planning and every agent session — vision, current priorities, what “done well” means. Stored in .orchestrator/goal.md."
              value={goal}
              minHeightClass="min-h-56 max-h-[32rem]"
              placeholder="e.g. Nous is a knowledge platform for SMEs. Current priority: …"
              onChange={setGoal}
              onSave={() => (repoId ? saveSettings(repoId, { goal }) : Promise.resolve())}
            />
          )}

          {tab === 'memory' && (
            <MarkdownEditorSection
              title="Memory"
              description="Reusable lessons injected into every session. Agents append here via save_memory (stamped with the issue number) — curate freely, delete anything wrong. Stored in .orchestrator/memory.md."
              value={memory}
              minHeightClass="min-h-72 max-h-[36rem]"
              placeholder="- [#312] The pre-commit hook requires all modified backend files staged…"
              onChange={setMemory}
              onSave={() => (repoId ? saveSettings(repoId, { memory }) : Promise.resolve())}
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
