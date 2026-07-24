'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

import { useRepo } from '@/components/shared/use-repo';

/**
 * "Add repository" modal (top bar + empty board): a display name plus a local
 * absolute path or a GitHub URL to clone. The name is what the repo switcher
 * shows (falls back to the folder name when left empty).
 */
export function AddRepoModal({ onClose }: { onClose: () => void }) {
  const { addRepo } = useRepo();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (!url.trim() || saving) return;
    setSaving(true);
    setError(null);
    addRepo(url.trim(), name)
      .then(onClose)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-label="Add repository"
    >
      <div
        className="flex w-full max-w-md flex-col rounded-lg border border-border bg-main-surface-primary p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold">Add repository</h2>
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

        <div className="mt-4 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Nous AI"
              className="h-9 w-full rounded-md border border-border bg-elevated-secondary px-3 text-sm placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              URL (GitHub URL to clone, or an absolute local path)
            </span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') save();
              }}
              placeholder="https://github.com/you/repo or /Users/you/repo"
              className="h-9 w-full rounded-md border border-border bg-elevated-secondary px-3 font-mono text-xs placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
            />
          </label>
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
              disabled={saving || !url.trim()}
              onClick={save}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Adding… (cloning can take a moment)' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
