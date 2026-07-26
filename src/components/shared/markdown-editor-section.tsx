'use client';

import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** "Edit" label + pill switch, matching the app's agent-instructions editor. */
export function EditToggle({
  editing,
  onChange,
}: {
  editing: boolean;
  onChange: (v: boolean) => void;
}) {
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

/** A titled markdown field with an edit/preview toggle and a Save button. */
export function MarkdownEditorSection({
  title,
  description,
  value,
  minHeightClass,
  placeholder,
  onChange,
  onSave,
}: {
  /** Omit when the surrounding tab header already names this field. */
  title?: string;
  description: string;
  value: string;
  minHeightClass: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
}) {
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
    <section className="flex flex-col py-6">
      <div className="flex items-center justify-between gap-3">
        {title ? (
          <h2 className="text-base font-bold text-foreground">{title}</h2>
        ) : (
          <span />
        )}
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
      <p className={`text-sm text-muted-foreground ${title ? 'mt-1' : ''}`}>{description}</p>

      {editing ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`mt-3 w-full rounded-md border border-border bg-elevated-secondary px-3 py-2 font-mono text-xs leading-5 placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50 ${minHeightClass}`}
        />
      ) : (
        <div
          className={`markdown-preview mt-3 overflow-auto rounded-md border border-border bg-elevated-secondary px-4 py-3 ${minHeightClass}`}
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
