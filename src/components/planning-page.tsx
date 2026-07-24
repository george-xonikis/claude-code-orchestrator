'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, MessageSquare, Sparkles, X } from 'lucide-react';

import type { PlanningPass, PlanningProposal } from '@/lib/types';
import { LabelChip } from '@/components/shared/label-chip';
import {
  discussProposal,
  dismissPlanningProposals,
  type DiscussionMessage,
  filePlanningProposals,
  getPlanning,
  setPlanningInterval,
  startPlanningPass,
} from '@/components/shared/task-actions';
import { useRepo } from '@/components/shared/use-repo';

/** Both planning persona files a repo needs under .claude/agents/. */
const PERSONA_FILES = ['.claude/agents/principal-engineer.md', '.claude/agents/product-manager.md'];

const INTERVAL_OPTIONS = [
  { value: '', label: 'Auto-run: off' },
  { value: '1', label: 'Every hour' },
  { value: '2', label: 'Every 2 hours' },
  { value: '4', label: 'Every 4 hours' },
  { value: '8', label: 'Every 8 hours' },
  { value: '24', label: 'Every 24 hours' },
] as const;

const SOURCE_BADGE: Record<PlanningProposal['source'], { label: string; className: string }> = {
  engineer: { label: 'ENG', className: 'bg-info-muted text-info' },
  pm: { label: 'PM', className: 'bg-warning-muted text-warning' },
  both: { label: 'ENG + PM', className: 'bg-success-muted text-success' },
};

function ProposalCard({
  proposal,
  selected,
  onToggle,
  onDiscuss,
}: {
  proposal: PlanningProposal;
  selected: boolean;
  onToggle: () => void;
  onDiscuss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const source = SOURCE_BADGE[proposal.source];
  const pending = proposal.status === 'pending';

  const handleCopy = () => {
    const text = `# ${proposal.title}\n\nLabels: ${proposal.labels.join(', ')}\n\n${proposal.body}`;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div
      className={`rounded-lg border p-4 ${
        proposal.status === 'dismissed'
          ? 'border-border opacity-50'
          : selected
            ? 'border-primary/60 bg-elevated-secondary'
            : 'border-border bg-elevated-secondary'
      }`}
    >
      <div className="flex items-start gap-3">
        {pending && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${proposal.title}`}
            className="mt-1 h-4 w-4 accent-[var(--theme-primary)]"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold leading-snug">{proposal.title}</span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${source.className}`}
            >
              {source.label}
            </span>
            {proposal.labels.map((label) => (
              <LabelChip key={label} label={label} />
            ))}
            {proposal.effort && (
              <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
                effort {proposal.effort}
              </span>
            )}
            {proposal.impact && (
              <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
                impact {proposal.impact}
              </span>
            )}
            {proposal.status === 'filed' && proposal.issueUrl && (
              <a
                href={proposal.issueUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] font-medium text-success hover:underline"
              >
                filed as #{proposal.issueNumber} ↗
              </a>
            )}
            {proposal.status === 'dismissed' && (
              <span className="text-[11px] text-muted-foreground">dismissed</span>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {expanded ? 'Hide details' : 'Show details'}
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy proposal'}
            </button>
            <button
              type="button"
              onClick={onDiscuss}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <MessageSquare className="h-3 w-3" />
              Discuss
            </button>
          </div>
          {expanded && (
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-main-surface-primary p-3 font-mono text-[11px] leading-5 text-muted-foreground">
              {proposal.body}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlanningPage() {
  const { current, loaded: reposLoaded } = useRepo();
  const repoId = current?.id ?? null;
  const [passes, setPasses] = useState<PlanningPass[]>([]);
  const [intervalHours, setIntervalHours] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [discussing, setDiscussing] = useState<{ passId: string; proposalId: string } | null>(
    null
  );

  const refresh = useCallback(() => {
    if (!repoId) return;
    getPlanning(repoId)
      .then((data) => {
        setPasses(data.passes);
        setIntervalHours(data.intervalHours);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [repoId]);

  const handleIntervalChange = (value: string) => {
    if (!repoId) return;
    const hours = value === '' ? null : Number(value);
    setIntervalHours(hours); // optimistic
    setPlanningInterval(repoId, hours).catch(() => {});
  };

  // Reset during render when the selected repo changes (React's derived-state
  // pattern), so the effect below only refetches.
  const [loadedRepoId, setLoadedRepoId] = useState(repoId);
  if (loadedRepoId !== repoId) {
    setLoadedRepoId(repoId);
    setPasses([]);
    setIntervalHours(null);
    setSelected(new Set());
    setDiscussing(null);
    setLoaded(false);
  }

  useEffect(refresh, [refresh]);

  const latest = passes[0];
  const running = latest?.status === 'running';

  // Poll while a pass is running.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [running, refresh]);

  // Selection works across ALL passes — keys are `${passId}:${proposalId}`.
  const toggle = (passId: string, proposalId: string) => {
    const key = `${passId}:${proposalId}`;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedIdsIn = (pass: PlanningPass) =>
    pass.proposals.filter((p) => selected.has(`${pass.id}:${p.id}`)).map((p) => p.id);

  const handleStart = () => {
    if (!repoId) return;
    setBusy(true);
    startPlanningPass(repoId)
      .then(refresh)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const act = (
    action: (repoId: string, passId: string, ids: string[]) => Promise<void>,
    pass: PlanningPass,
  ) => {
    if (!repoId) return;
    const ids = selectedIdsIn(pass);
    if (ids.length === 0) return;
    setBusy(true);
    action(repoId, pass.id, ids)
      .then(() => {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(`${pass.id}:${id}`);
          return next;
        });
      })
      .then(refresh)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  if (reposLoaded && !current) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Add a repository on the board to run planning passes.
      </div>
    );
  }

  if (!loaded) {
    return <div className="p-6 text-sm text-muted-foreground">Loading planning passes…</div>;
  }

  const missingPersonas = current?.hasPersonas === false;

  return (
    <div className="flex items-start gap-6 p-6">
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-sm font-bold">Planning</h1>
        <div className="flex shrink-0 items-center gap-2">
          <select
            value={intervalHours === null ? '' : String(intervalHours)}
            onChange={(event) => handleIntervalChange(event.target.value)}
            aria-label="Auto-run interval"
            className="h-8 rounded-md border border-border bg-elevated-secondary px-2 text-xs font-medium outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
          >
            {INTERVAL_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || running || missingPersonas}
            onClick={handleStart}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {running ? 'Planning…' : 'Plan'}
          </button>
        </div>
      </div>

      {missingPersonas && (
        <div className="rounded-lg bg-warning-muted px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-warning">
            Planning personas missing
          </div>
          <p className="mt-1 text-sm leading-snug">
            {current?.name} has no planning personas. Add both files to run a pass:{' '}
            <code className="font-mono text-[11px]">{PERSONA_FILES[0]}</code> and{' '}
            <code className="font-mono text-[11px]">{PERSONA_FILES[1]}</code>.
          </p>
        </div>
      )}

      {passes.length === 0 && !missingPersonas && (
        <p className="text-sm text-muted-foreground">No planning passes yet — run the first one.</p>
      )}

      {passes.map((pass) => {
        const pendingCount = pass.proposals.filter((p) => p.status === 'pending').length;
        const selectedCount = selectedIdsIn(pass).length;
        return (
          <section key={pass.id}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {new Date(pass.startedAt).toLocaleString()} · {pass.status}
                {pass.status === 'complete' && ` · ${pass.proposals.length} proposals`}
              </span>
              {pendingCount > 0 && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy || selectedCount === 0}
                    onClick={() => act(filePlanningProposals, pass)}
                    className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    Create {selectedCount || ''} issue{selectedCount === 1 ? '' : 's'}
                  </button>
                  <button
                    type="button"
                    disabled={busy || selectedCount === 0}
                    onClick={() => act(dismissPlanningProposals, pass)}
                    className="inline-flex h-7 items-center rounded-md border border-border bg-elevated-secondary px-2.5 text-xs font-medium hover:bg-background-hover disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
            {pass.status === 'running' && (
              <p className="text-sm text-muted-foreground">
                Engineer and PM agents are scanning the repo — this takes a few minutes…
              </p>
            )}
            {pass.status === 'failed' && (
              <p className="text-sm text-destructive">Pass failed: {pass.error}</p>
            )}
            <div className="flex flex-col gap-2">
              {pass.proposals.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  selected={selected.has(`${pass.id}:${proposal.id}`)}
                  onToggle={() => toggle(pass.id, proposal.id)}
                  onDiscuss={() => setDiscussing({ passId: pass.id, proposalId: proposal.id })}
                />
              ))}
            </div>
          </section>
        );
      })}
      </div>
      {repoId && discussing && (
        <DiscussDrawer
          repoId={repoId}
          passId={discussing.passId}
          proposal={
            passes
              .find((p) => p.id === discussing.passId)
              ?.proposals.find((p) => p.id === discussing.proposalId) ?? null
          }
          proposalId={discussing.proposalId}
          onProposalChanged={refresh}
          onClose={() => setDiscussing(null)}
        />
      )}
    </div>
  );
}

/**
 * Chat drawer for one proposal. The transcript lives in this component (cleared
 * on close); each send is one stateless server turn that may apply proposal
 * edits through the update_proposal / create_proposal tools.
 */
function DiscussDrawer({
  repoId,
  passId,
  proposal,
  proposalId,
  onProposalChanged,
  onClose,
}: {
  repoId: string;
  passId: string;
  proposal: PlanningProposal | null;
  proposalId: string;
  onProposalChanged: () => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<DiscussionMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, thinking]);

  const send = () => {
    const text = draft.trim();
    if (!text || thinking) return;
    const next: DiscussionMessage[] = [...messages, { role: 'user', text }];
    setMessages(next);
    setDraft('');
    setThinking(true);
    discussProposal(repoId, passId, proposalId, next)
      .then((reply) => {
        setMessages([...next, { role: 'assistant', text: reply }]);
        onProposalChanged(); // pick up any tool-applied edits
      })
      .catch((err) => {
        setMessages([
          ...next,
          { role: 'assistant', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ]);
      })
      .finally(() => setThinking(false));
  };

  return (
    <aside className="sticky top-20 flex h-[calc(100dvh-7.5rem)] w-[26rem] shrink-0 flex-col self-start rounded-lg border border-border bg-main-surface-primary">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Discuss proposal
          </div>
          <div className="text-sm font-semibold leading-snug">{proposal?.title ?? proposalId}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close discussion"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-background-hover"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Challenge the proposal, ask for evidence from the code, or request changes — agreed
            edits are applied to the proposal directly (and it can split scope into a new
            proposal).
          </p>
        )}
        {messages.map((message, index) => (
          <div
            key={index}
            className={`max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
              message.role === 'user'
                ? 'ml-auto bg-primary/10'
                : 'bg-elevated-secondary'
            }`}
          >
            {message.text}
          </div>
        ))}
        {thinking && <p className="text-xs text-muted-foreground">Thinking…</p>}
      </div>
      <div className="border-t border-border p-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder="Discuss with Claude"
          className="min-h-16 w-full rounded-md border border-border bg-elevated-secondary px-3 py-2 text-sm placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
        />
        <button
          type="button"
          disabled={thinking || !draft.trim()}
          onClick={send}
          className="mt-2 inline-flex h-8 w-full items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </aside>
  );
}
