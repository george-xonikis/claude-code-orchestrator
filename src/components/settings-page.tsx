'use client';

import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  type AutonomyConfig,
  getAutonomy,
  getSettings,
  saveSettings,
  setAutonomy,
} from '@/components/shared/task-actions';
import { useRepo } from '@/components/shared/use-repo';

/** "Edit" label + pill switch, matching the main app's agent-instructions editor. */
function EditToggle({ editing, onChange }: { editing: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Edit</span>
      <button
        type="button"
        role="switch"
        aria-checked={editing}
        onClick={() => onChange(!editing)}
        className={`relative h-5 w-9 rounded-full transition-colors ${
          editing ? 'bg-primary' : 'bg-muted'
        }`}
      >
        <span
          className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
            editing ? 'translate-x-[18px]' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  );
}

interface SectionProps {
  title: string;
  description: string;
  value: string;
  minHeightClass: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
}

function SettingsSection({
  title,
  description,
  value,
  minHeightClass,
  placeholder,
  onChange,
  onSave,
}: SectionProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaving(true);
    setSaved(false);
    onSave()
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <section className="rounded-lg bg-elevated-secondary p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold">{title}</h2>
        <div className="flex shrink-0 items-center gap-3">
          {saved && <span className="text-xs font-medium text-success">Saved</span>}
          {editing && (
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          <EditToggle editing={editing} onChange={setEditing} />
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>

      {editing ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`mt-3 w-full rounded-md border border-border bg-main-surface-primary px-3 py-2 font-mono text-xs leading-5 placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50 ${minHeightClass}`}
        />
      ) : (
        <div
          className={`markdown-preview mt-3 overflow-auto rounded-md border border-border bg-main-surface-primary px-4 py-3 ${minHeightClass}`}
        >
          {value.trim() ? (
            <Markdown remarkPlugins={[remarkGfm]}>{value}</Markdown>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing to preview yet.</p>
          )}
        </div>
      )}
    </section>
  );
}

/** Pill switch (same visual as EditToggle) for a standalone on/off setting. */
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

const NUMBER_SELECT_CLASS =
  'h-8 rounded-md border border-border bg-main-surface-primary px-2 text-xs font-medium outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50 disabled:opacity-50';

/**
 * Autonomous mode: when on, scheduled planning passes auto-file their top
 * proposals and the loop auto-starts sessions up to the concurrency cap. The
 * merge/PR step stays human. Config is per-repo, stored with the planning data.
 */
function AutonomySection({ repoId }: { repoId: string }) {
  const [cfg, setCfg] = useState<AutonomyConfig | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getAutonomy(repoId).then(setCfg).catch(() => {});
  }, [repoId]);

  const patch = (p: Partial<AutonomyConfig>) => {
    setCfg((prev) => (prev ? { ...prev, ...p } : prev)); // optimistic
    setSaved(false);
    setAutonomy(repoId, p)
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <section className="rounded-lg bg-elevated-secondary p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold">Autonomous mode</h2>
        <div className="flex shrink-0 items-center gap-3">
          {saved && <span className="text-xs font-medium text-success">Saved</span>}
          <Switch
            checked={cfg?.autonomous ?? false}
            disabled={!cfg}
            onChange={(v) => patch({ autonomous: v })}
          />
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        When on, scheduled planning passes auto-file their top proposals as issues and the
        orchestrator auto-starts agent sessions up to the concurrency cap — no board clicks. The
        loop runs <span className="font-medium">plan → file → code → commit</span> and stops there:
        pushing the branch and opening the PR stays a manual, human-reviewed step.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium">
            Max concurrent sessions
            <span className="ml-1 text-muted-foreground">— the main cost control</span>
          </span>
          <select
            value={cfg?.maxActive ?? 2}
            disabled={!cfg}
            onChange={(e) => patch({ maxActive: Number(e.target.value) })}
            className={NUMBER_SELECT_CLASS}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium">
            Max proposals auto-filed per pass
            <span className="ml-1 text-muted-foreground">— top-ranked first</span>
          </span>
          <select
            value={cfg?.maxAutoFile ?? 3}
            disabled={!cfg}
            onChange={(e) => patch({ maxAutoFile: Number(e.target.value) })}
            className={NUMBER_SELECT_CLASS}
          >
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const { current, loaded: reposLoaded } = useRepo();
  const repoId = current?.id ?? null;
  const [goal, setGoal] = useState('');
  const [memory, setMemory] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Reset during render when the selected repo changes (React's derived-state
  // pattern), so the effect below only refetches.
  const [loadedRepoId, setLoadedRepoId] = useState(repoId);
  if (loadedRepoId !== repoId) {
    setLoadedRepoId(repoId);
    setGoal('');
    setMemory('');
    setLoaded(false);
  }

  useEffect(() => {
    if (!repoId) return;
    getSettings(repoId)
      .then((settings) => {
        setGoal(settings.goal);
        setMemory(settings.memory);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [repoId]);

  if (reposLoaded && !current) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Add a repository on the board to edit its goal and memory.
      </div>
    );
  }

  if (!loaded) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      {repoId && <AutonomySection key={repoId} repoId={repoId} />}
      <SettingsSection
        title="Goal"
        description="Injected into every agent session's prompt — vision, current priorities, what “done well” means. Stored in .orchestrator/goal.md."
        value={goal}
        minHeightClass="min-h-56 max-h-[32rem]"
        placeholder="e.g. Nous is a knowledge platform for SMEs. Current priority: …"
        onChange={setGoal}
        onSave={() => (repoId ? saveSettings(repoId, { goal }) : Promise.resolve())}
      />
      <SettingsSection
        title="Memory"
        description="Reusable lessons injected into every session. Agents append here via save_memory (stamped with the issue number) — curate freely, delete anything wrong. Stored in .orchestrator/memory.md."
        value={memory}
        minHeightClass="min-h-72 max-h-[36rem]"
        placeholder="- [#312] The pre-commit hook requires all modified backend files staged…"
        onChange={setMemory}
        onSave={() => (repoId ? saveSettings(repoId, { memory }) : Promise.resolve())}
      />
    </div>
  );
}
