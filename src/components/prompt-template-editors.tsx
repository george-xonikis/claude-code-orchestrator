'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import {
  getPromptTemplates,
  type PromptKind,
  type PromptTemplates,
  type PromptTemplateState,
  savePromptTemplate,
} from '@/components/shared/task-actions';

/**
 * The app-level session-prompt template editors, embedded on the Help page
 * right below the prompt-anatomy illustration. Not repo-scoped: the templates
 * are Hydra's session envelope and apply to every managed repo (stored in
 * data/prompts/); anything repo-specific belongs in that repo's own .claude/.
 */

const PROMPT_EDITORS: {
  kind: PromptKind;
  title: string;
  description: string;
  placeholders: string[];
}[] = [
  {
    kind: 'implementation',
    title: 'Implementation session',
    description:
      'Launches every agent session that works an issue. Stored in data/prompts/implementation.md when customized.',
    placeholders: ['issueNumber', 'worktreePath', 'branch', 'workflowHint', 'productMap'],
  },
  {
    kind: 'conflict',
    title: 'Conflict resolution',
    description:
      'Launches the session that rebases a conflicting PR branch onto the default branch. Stored in data/prompts/conflict.md when customized.',
    placeholders: ['issueNumber', 'prNumber', 'worktreePath', 'branch', 'baseBranch', 'workflowHint'],
  },
  {
    kind: 'agents-planning',
    title: 'Planning agent pass',
    description:
      'The read-only PE/PM scan wrapper — wraps each planning agent for one pass over the repo. Stored in data/prompts/agents-planning.md when customized.',
    placeholders: ['personaBody', 'shaping', 'adHocDirection', 'planningMemory', 'exclusions'],
  },
  {
    kind: 'synthesis',
    title: 'Synthesis',
    description:
      'Merges the PE and PM reports into one deduped, ranked JSON proposal list. Stored in data/prompts/synthesis.md when customized.',
    placeholders: [
      'engineerReport',
      'pmReport',
      'maxProposals',
      'shapingConstraints',
      'adHocDirection',
      'planningMemory',
      'exclusions',
    ],
  },
  {
    kind: 'refinement',
    title: 'Refinement agent pass',
    description:
      'Wraps each planning agent (PE/PM) for a read-only judgement of the open backlog (pending proposals + untouched proposed issues) against the current code. Stored in data/prompts/refinement.md when customized.',
    placeholders: ['personaBody', 'goal', 'planningMemory', 'items'],
  },
  {
    kind: 'refinement-synthesis',
    title: 'Refinement synthesis',
    description:
      'Merges the PE and PM refinement reports into final keep/drop verdicts (conservative on disagreement). Stored in data/prompts/refinement-synthesis.md when customized.',
    placeholders: ['engineerReport', 'pmReport', 'items'],
  },
  {
    kind: 'adhoc-chat',
    title: 'Ad-hoc planning chat',
    description:
      'The ad-hoc planning chat turn — shapes the direction of the next ad-hoc pass without scanning the repo. Stored in data/prompts/adhoc-chat.md when customized.',
    placeholders: ['goal', 'currentProposals', 'transcript'],
  },
  {
    kind: 'proposal-discussion',
    title: 'Proposal discussion',
    description:
      'The Discuss drawer — one chat turn about a single proposal, with the update/create proposal tools. Stored in data/prompts/proposal-discussion.md when customized.',
    placeholders: ['goal', 'proposal', 'transcript'],
  },
  {
    kind: 'product-map',
    title: 'Product map bootstrap',
    description:
      'Generates the initial product map (lands uncommitted at docs/product-map.md in the repo). Stored in data/prompts/product-map.md when customized.',
    placeholders: ['agentBody'],
  },
];

/**
 * One template editor as an accordion panel: the header row (title, badge)
 * toggles it open; the body holds the description, placeholder reference, a
 * plain textarea (templates are prompt text, not markdown worth previewing),
 * Save, and Reset to default. Open state lives in the parent so the panel
 * survives the remount that follows a save/reset.
 */
function PromptTemplateEditor({
  title,
  description,
  placeholders,
  state,
  open,
  onToggle,
  onSave,
  onReset,
}: {
  title: string;
  description: string;
  placeholders: string[];
  state: PromptTemplateState;
  open: boolean;
  onToggle: () => void;
  onSave: (template: string) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(state.template);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = draft !== state.template;

  const run = (action: Promise<void>) => {
    setSaving(true);
    setSaved(false);
    action
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <section className="rounded-xl border border-border bg-elevated-secondary">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl p-4 text-left hover:bg-background-hover"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <h3 className="text-[13px] font-bold">{title}</h3>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            state.isCustom
              ? 'bg-warning-muted text-warning'
              : 'bg-secondary text-secondary-foreground'
          }`}
        >
          {state.isCustom ? 'Customized' : 'Default'}
        </span>
        {saved && <span className="ml-auto text-xs font-medium text-success">Saved</span>}
      </button>
      {open && (
        <div className="border-t border-border p-4 pt-3">
          <p className="text-xs text-muted-foreground">{description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium">Placeholders:</span>
            {placeholders.map((name) => (
              <code key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono">
                {`{{${name}}}`}
              </code>
            ))}
            <span className="basis-full">
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{'{{#name}}…{{/name}}'}</code>{' '}
              keeps its block only when the value is non-empty. Clearing the text and saving also
              restores the default.
            </span>
          </div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="mt-3 max-h-[40rem] min-h-72 w-full rounded-md border border-border bg-main-surface-primary px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
          />
          <div className="mt-3 flex items-center justify-end gap-3">
            {state.isCustom && (
              <button
                type="button"
                disabled={saving}
                onClick={() => run(onReset())}
                className="inline-flex h-8 items-center rounded-md border border-border bg-main-surface-primary px-3 text-xs font-medium hover:bg-background-hover disabled:opacity-50"
              >
                Reset to default
              </button>
            )}
            <button
              type="button"
              disabled={saving || !dirty}
              onClick={() => run(onSave(draft))}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function PromptTemplateEditors() {
  const [prompts, setPrompts] = useState<PromptTemplates | null>(null);
  // Open panels live here (not in the editors) so a save/reset remount keeps them open.
  const [open, setOpen] = useState<ReadonlySet<PromptKind>>(new Set());

  useEffect(() => {
    getPromptTemplates().then(setPrompts).catch(() => {});
  }, []);

  const toggle = (kind: PromptKind) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  if (!prompts) {
    return <p className="text-sm text-muted-foreground">Loading templates…</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {/* Skip kinds the server doesn't serve yet (defensive: keeps the page
          rendering if the API and this list ever drift). */}
      {PROMPT_EDITORS.filter(({ kind }) => prompts[kind]).map(
        ({ kind, title, description, placeholders }) => (
        <PromptTemplateEditor
          // Remount when the stored state flips (save/reset) so the draft
          // re-seeds from the server's echo.
          key={`${kind}:${prompts[kind].isCustom}`}
          title={title}
          description={description}
          placeholders={placeholders}
          state={prompts[kind]}
          open={open.has(kind)}
          onToggle={() => toggle(kind)}
          onSave={(template) => savePromptTemplate(kind, template).then(setPrompts)}
          onReset={() => savePromptTemplate(kind, null).then(setPrompts)}
        />
        )
      )}
    </div>
  );
}
