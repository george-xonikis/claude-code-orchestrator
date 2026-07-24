'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, X } from 'lucide-react';

import {
  EFFORT_METER,
  GradeMeterInput,
  IMPACT_METER,
} from '@/components/shared/grade-meter';
import { MarkdownEditorSection } from '@/components/shared/markdown-editor-section';
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

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

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

const TABS = [
  { value: 'goal', label: 'Goal' },
  { value: 'agents', label: 'Agents' },
  { value: 'automation', label: 'Automation' },
  { value: 'proposals', label: 'Proposals' },
] as const;

type ConfigTab = (typeof TABS)[number]['value'];

export function PlanConfigPage() {
  const { current, loaded: reposLoaded } = useRepo();
  const repoId = current?.id ?? null;
  const [cfg, setCfg] = useState<PlanningConfig | null>(null);
  const [goal, setGoal] = useState('');
  const [topicDraft, setTopicDraft] = useState('');
  const [tab, setTab] = useState<ConfigTab>('goal');

  // Reset during render when the repo changes (derived-state pattern).
  const [loadedRepoId, setLoadedRepoId] = useState(repoId);
  if (loadedRepoId !== repoId) {
    setLoadedRepoId(repoId);
    setCfg(null);
    setGoal('');
    setTopicDraft('');
  }

  useEffect(() => {
    if (!repoId) return;
    getPlanningConfig(repoId).then(setCfg).catch(() => {});
    getSettings(repoId)
      .then((s) => setGoal(s.goal))
      .catch(() => {});
  }, [repoId]);

  /** Optimistically apply a patch and persist it (server echoes the sanitized config). */
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

  const header = (
    <div className="flex items-center gap-3">
      <Link
        href="/planning"
        aria-label="Back to Planning"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-elevated-secondary hover:bg-background-hover"
      >
        <ArrowLeft className="h-4 w-4" />
      </Link>
      <h1 className="text-sm font-bold">Planning configuration</h1>
    </div>
  );

  if (reposLoaded && !current) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
        {header}
        <p className="text-sm text-muted-foreground">
          Add a repository on the board to configure planning.
        </p>
      </div>
    );
  }

  if (!cfg) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
        {header}
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      {header}

      <div className="flex flex-col gap-6 sm:flex-row">
        <nav
          role="tablist"
          aria-orientation="vertical"
          aria-label="Planning configuration"
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

          {tab === 'agents' && (
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
          )}

          {tab === 'automation' && (
            <>
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

              <Section title="Automation">
                <p className="text-xs text-muted-foreground">
                  Independent switches. The loop runs plan → file → code → commit and stops there
                  — pushing the branch and opening the PR stays a manual, human-reviewed step.
                </p>
                <Row label="Auto-file proposals" hint="scheduled passes open issues">
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
                <Row label="Auto-start sessions" hint="agents pick up ready issues">
                  <Switch checked={cfg.autoStart} onChange={(v) => patch({ autoStart: v })} />
                </Row>
                {cfg.autoStart && (
                  <Row label="Max concurrent sessions" hint="the main cost control">
                    <NumberSelect
                      value={cfg.maxActive}
                      min={1}
                      max={5}
                      onChange={(n) => patch({ maxActive: n })}
                    />
                  </Row>
                )}
              </Section>
            </>
          )}

          {tab === 'proposals' && (
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
          )}
        </div>
      </div>
    </div>
  );
}
