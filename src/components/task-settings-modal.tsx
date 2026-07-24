'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import type { Task } from '@/lib/types';
import { MODEL_OPTIONS } from '@/components/shared/format';
import { getTicketSettings, saveTicketSettings } from '@/components/shared/task-actions';

/**
 * Per-ticket settings: name + description (written back to the GitHub issue),
 * model for the next session, and the dynamic-workflow toggle.
 */
export function TaskSettingsModal({
  repoId,
  task,
  onClose,
}: {
  repoId: string;
  task: Task;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState('');
  const [model, setModel] = useState<string>(task.preferredModel ?? MODEL_OPTIONS[0].id);
  const [useWorkflow, setUseWorkflow] = useState(task.useWorkflow ?? false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTicketSettings(repoId, task.issueNumber)
      .then((settings) => {
        setTitle(settings.title);
        setBody(settings.body);
        if (settings.preferredModel) setModel(settings.preferredModel);
        if (settings.useWorkflow !== undefined) setUseWorkflow(settings.useWorkflow);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoaded(true));
  }, [repoId, task.issueNumber]);

  const save = () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    saveTicketSettings(repoId, task.issueNumber, {
      title: title.trim(),
      body,
      preferredModel: model,
      useWorkflow,
    })
      .then(onClose)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-label={`Settings for issue #${task.issueNumber}`}
    >
      <div
        className="flex max-h-[85dvh] w-full max-w-xl flex-col overflow-y-auto rounded-lg border border-border bg-main-surface-primary p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold">Ticket #{task.issueNumber} settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-background-hover"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        {!loaded ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading ticket…</p>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Name</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="h-9 w-full rounded-md border border-border bg-elevated-secondary px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Description (the GitHub issue body — the agent&apos;s task spec)
              </span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                className="min-h-52 w-full rounded-md border border-border bg-elevated-secondary px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
              />
            </label>
            <div className="flex flex-wrap items-center gap-6">
              <label className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Model</span>
                <select
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  className="h-8 rounded-md border border-border bg-elevated-secondary px-2 text-xs font-medium outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
                >
                  {MODEL_OPTIONS.map(({ id, label }) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={useWorkflow}
                  onChange={(event) => setUseWorkflow(event.target.checked)}
                  className="h-4 w-4 accent-[var(--theme-primary)]"
                />
                <span className="text-xs font-medium">
                  Dynamic workflow{' '}
                  <span className="text-muted-foreground">(agent may fan out subagents)</span>
                </span>
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-8 items-center rounded-md border border-border bg-elevated-secondary px-3 text-xs font-medium hover:bg-background-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || !title.trim()}
                onClick={save}
                className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
