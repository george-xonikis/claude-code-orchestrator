'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  DollarSign,
  Hammer,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { PlanningLogLine, PlanningPass, PlanningProposal } from '@/lib/types';
import { ClaudeLogo } from '@/components/shared/claude-logo';
import { LabelChip } from '@/components/shared/label-chip';
import {
  cancelPlanningPass,
  clearProposalDiscussion,
  discussProposal,
  dismissPlanningProposals,
  type DiscussionMessage,
  filePlanningProposals,
  getPlanning,
  type PlanningRole,
  setPlanningInterval,
  startPlanningPass,
} from '@/components/shared/task-actions';
import { useRepo } from '@/components/shared/use-repo';

/** Planning persona file for each role, under .claude/agents/. */
const PERSONA_FILE_BY_ROLE: Record<PlanningRole, string> = {
  engineer: '.claude/agents/principal-engineer.md',
  pm: '.claude/agents/product-manager.md',
};

/** Which agents a "Plan" click runs. */
const PLAN_SCOPES = [
  { value: 'both', label: 'PE + PM', roles: ['engineer', 'pm'] as PlanningRole[] },
  { value: 'engineer', label: 'PE only', roles: ['engineer'] as PlanningRole[] },
  { value: 'pm', label: 'PM only', roles: ['pm'] as PlanningRole[] },
] as const;

type PlanScope = (typeof PLAN_SCOPES)[number]['value'];

const INTERVAL_OPTIONS = [
  { value: '', label: 'Auto-run: off' },
  { value: '1', label: 'Every hour' },
  { value: '2', label: 'Every 2 hours' },
  { value: '4', label: 'Every 4 hours' },
  { value: '8', label: 'Every 8 hours' },
  { value: '24', label: 'Every 24 hours' },
] as const;

const SOURCE_BADGE: Record<PlanningProposal['source'], { label: string; className: string }> = {
  engineer: { label: 'PE', className: 'bg-info-muted text-info' },
  pm: { label: 'PM', className: 'bg-warning-muted text-warning' },
  both: { label: 'PE + PM', className: 'bg-success-muted text-success' },
};

/** Legacy S/M/L and high/medium grades, mapped onto the 1-5 scale for display. */
const GRADE_ALIASES: Record<string, number> = {
  xs: 1, s: 2, small: 2, m: 3, med: 3, medium: 3, l: 4, large: 4, xl: 5,
  low: 2, high: 5, critical: 5,
};

/** Coerce an effort/impact value ("1"-"5" or a legacy word) to a 1-5 grade. */
function toGrade(value?: string): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && trimmed !== '') {
    return Math.max(1, Math.min(5, Math.round(numeric)));
  }
  return GRADE_ALIASES[trimmed.toLowerCase()] ?? null;
}

/** A 1-5 rating rendered as five icons, `grade` of them filled. */
function GradeMeter({
  icon: Icon,
  grade,
  label,
  filledClassName,
}: {
  icon: typeof DollarSign;
  grade: number;
  label: string;
  filledClassName: string;
}) {
  return (
    <span
      title={`${label} ${grade}/5`}
      aria-label={`${label} ${grade} out of 5`}
      className="inline-flex items-center gap-0.5 rounded-full bg-secondary px-2 py-1"
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <Icon
          key={i}
          className={`h-3 w-3 ${i < grade ? filledClassName : 'text-muted-foreground/25'}`}
        />
      ))}
    </span>
  );
}

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
      className={`group rounded-lg border p-4 ${
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
            {toGrade(proposal.effort) !== null && (
              <GradeMeter
                icon={Hammer}
                grade={toGrade(proposal.effort) as number}
                label="Effort"
                filledClassName="text-warning"
              />
            )}
            {toGrade(proposal.impact) !== null && (
              <GradeMeter
                icon={DollarSign}
                grade={toGrade(proposal.impact) as number}
                label="Impact"
                filledClassName="text-success"
              />
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
          <div className="mt-2 flex items-center justify-between gap-3">
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
              onClick={onDiscuss}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-[#D97757]/40 bg-[#D97757]/10 px-4 text-sm font-semibold text-foreground opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[#D97757]/20"
            >
              <ClaudeLogo className="h-4 w-4 text-[#D97757]" />
              Claude
            </button>
          </div>
          {expanded && (
            <div className="mt-2">
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-main-surface-primary p-3 font-mono text-[11px] leading-5 text-muted-foreground">
                {proposal.body}
              </pre>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-background-hover hover:text-foreground"
                >
                  {copied ? (
                    <Check className="h-3 w-3 text-success" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copied ? 'Copied' : 'Copy proposal'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const LOG_ROLE_META: Record<PlanningLogLine['role'], { label: string; className: string }> = {
  engineer: { label: 'PE', className: 'text-info' },
  pm: { label: 'PM', className: 'text-warning' },
  synthesis: { label: 'SYN', className: 'text-success' },
};

/** Collapsible accordion of a pass's captured agent activity; stays viewable when done. */
function PassLog({ logs, running }: { logs: PlanningLogLine[]; running: boolean }) {
  const [open, setOpen] = useState(running);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && running) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [logs, open, running]);

  if (logs.length === 0) return null;

  return (
    <div className="mb-2 rounded-md border border-border bg-elevated-secondary">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Plan activity log
        <span className="font-normal text-muted-foreground/70">· {logs.length} events</span>
        {running && (
          <span className="ml-1 inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
        )}
      </button>
      {open && (
        <div
          ref={scrollRef}
          className="max-h-80 space-y-1 overflow-auto border-t border-border p-3"
        >
          {logs.map((line, index) => {
            const meta = LOG_ROLE_META[line.role];
            return (
              <div key={index} className="flex gap-2 text-[11px] leading-5">
                <span className={`w-8 shrink-0 font-mono font-semibold ${meta.className}`}>
                  {meta.label}
                </span>
                <span
                  className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${
                    line.kind === 'tool'
                      ? 'font-mono text-muted-foreground'
                      : 'text-foreground'
                  }`}
                >
                  {line.kind === 'tool' ? `⚙ ${line.text}` : line.text}
                </span>
              </div>
            );
          })}
        </div>
      )}
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
  const [cancelling, setCancelling] = useState(false);
  const [scope, setScope] = useState<PlanScope>('both');
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

  const scopeRoles = PLAN_SCOPES.find((s) => s.value === scope)!.roles;

  const handleStart = () => {
    if (!repoId) return;
    setBusy(true);
    startPlanningPass(repoId, scopeRoles)
      .then(refresh)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const handleCancel = () => {
    if (!repoId) return;
    setCancelling(true);
    cancelPlanningPass(repoId)
      .then(refresh)
      .catch(() => {})
      .finally(() => setCancelling(false));
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

  // Per-role persona presence (falls back to hasPersonas if the granular flag
  // isn't on the repo yet), gated to the roles the chosen scope will run.
  const personas = current?.personas ?? {
    engineer: current?.hasPersonas ?? false,
    pm: current?.hasPersonas ?? false,
  };
  const missingForScope = scopeRoles.filter((role) => !personas[role]);
  const canPlan = missingForScope.length === 0;

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
          {!running && (
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as PlanScope)}
              aria-label="Planning scope"
              className="h-8 rounded-md border border-border bg-elevated-secondary px-2 text-xs font-medium outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
            >
              {PLAN_SCOPES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={busy || running || !canPlan}
            onClick={handleStart}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {running ? 'Planning…' : 'Plan'}
          </button>
          {running && (
            <button
              type="button"
              disabled={cancelling}
              onClick={handleCancel}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-elevated-secondary px-3 text-xs font-medium hover:bg-background-hover disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </div>
      </div>

      {missingForScope.length > 0 && (
        <div className="rounded-lg bg-warning-muted px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-warning">
            Planning persona{missingForScope.length > 1 ? 's' : ''} missing
          </div>
          <p className="mt-1 text-sm leading-snug">
            This scope needs{' '}
            {missingForScope.map((role, i) => (
              <span key={role}>
                {i > 0 && ' and '}
                <code className="font-mono text-[11px]">{PERSONA_FILE_BY_ROLE[role]}</code>
              </span>
            ))}
            . Add {missingForScope.length > 1 ? 'them' : 'it'} to run, or pick a different scope.
          </p>
        </div>
      )}

      {passes.length === 0 && canPlan && (
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
            {pass.status === 'failed' &&
              (pass.error?.startsWith('Cancelled') ? (
                <p className="mb-2 text-sm text-muted-foreground">Pass cancelled</p>
              ) : (
                <p className="mb-2 text-sm text-destructive">Pass failed: {pass.error}</p>
              ))}
            <PassLog logs={pass.logs ?? []} running={pass.status === 'running'} />
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
          key={discussing.proposalId}
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
 * Chat drawer for one proposal. The transcript is hydrated from the proposal's
 * persisted `discussion` on mount and re-persisted server-side after each turn,
 * so it survives refresh/navigation. Keyed by proposalId so switching proposals
 * remounts with the right transcript. Each send is one server turn that may
 * apply proposal edits through the update_proposal / create_proposal tools.
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
  // Hydrate from the proposal's persisted transcript so a refresh/navigation
  // (which remounts this drawer) restores the discussion instead of losing it.
  const [messages, setMessages] = useState<DiscussionMessage[]>(
    () => proposal?.discussion ?? []
  );
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

  const clear = () => {
    if (thinking || messages.length === 0) return;
    setMessages([]);
    clearProposalDiscussion(repoId, passId, proposalId)
      .then(onProposalChanged)
      .catch(() => {
        // Non-fatal: the local view is already cleared; surface it inline.
        setMessages([
          { role: 'assistant', text: 'Could not clear the saved transcript — try again.' },
        ]);
      });
  };

  return (
    <aside className="sticky top-20 flex h-[calc(100dvh-6rem)] w-[26rem] shrink-0 flex-col self-start rounded-lg border border-border bg-main-surface-primary">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Discuss proposal
          </div>
          <div className="text-sm font-semibold leading-snug">{proposal?.title ?? proposalId}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={clear}
            disabled={thinking || messages.length === 0}
            aria-label="Clear discussion"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-background-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close discussion"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-background-hover"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto p-4">
        {/* mt-auto anchors the conversation to the bottom (next to the input) so an
            empty/short chat doesn't leave a void in the middle; it collapses to 0
            once the messages overflow and the area scrolls normally. */}
        <div className="mt-auto space-y-3">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Challenge the proposal, ask for evidence from the code, or request changes — agreed
            edits are applied to the proposal directly (and it can split scope into a new
            proposal).
          </p>
        )}
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div
              key={index}
              className="ml-auto max-w-[90%] whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2 text-sm"
            >
              {message.text}
            </div>
          ) : (
            <div
              key={index}
              className="markdown-preview max-w-[90%] rounded-lg bg-elevated-secondary px-3 py-2 text-sm"
            >
              <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
            </div>
          )
        )}
        {thinking && <p className="text-xs text-muted-foreground">Thinking…</p>}
        </div>
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
