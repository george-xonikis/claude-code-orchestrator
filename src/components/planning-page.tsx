'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type {
  PlanningLogLine,
  PlanningPass,
  PlanningProposal,
  RefinementPass,
  RefinementVerdict,
} from '@/lib/types';
import { ClaudeLogo } from '@/components/shared/claude-logo';
import { EFFORT_METER, GradeMeter, IMPACT_METER } from '@/components/shared/grade-meter';
import { LabelChip } from '@/components/shared/label-chip';
import { PlanningSteeringChat } from '@/components/planning-steering-chat';
import {
  cancelPlanningPass,
  cancelRefinementPass,
  clearProposalDiscussion,
  discussProposal,
  dismissPlanningProposals,
  type DiscussionMessage,
  filePlanningProposals,
  getPlanning,
  getPlanningConfig,
  type PlanningConfig,
  type PlanningRole,
  resolveRefinementVerdict,
  startPlanningPass,
  startRefinementPass,
} from '@/components/shared/task-actions';
import { useRepo } from '@/components/shared/use-repo';

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

/** "The PE agent is" / "The PE and PM agents are" — reflects the pass's agents. */
function runningAgentsLabel(roles?: PlanningRole[]): string {
  const active = roles && roles.length > 0 ? roles : (['engineer', 'pm'] as PlanningRole[]);
  const names = active.map((role) => (role === 'engineer' ? 'PE' : 'PM')).join(' and ');
  return active.length > 1 ? `The ${names} agents are` : `The ${names} agent is`;
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
          <div className="text-sm font-semibold leading-snug">{proposal.title}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${source.className}`}
            >
              {source.label}
            </span>
            {proposal.labels.map((label) => (
              <LabelChip key={label} label={label} />
            ))}
            {toGrade(proposal.effort) !== null && (
              <GradeMeter style={EFFORT_METER} grade={toGrade(proposal.effort) as number} />
            )}
            {toGrade(proposal.impact) !== null && (
              <GradeMeter style={IMPACT_METER} grade={toGrade(proposal.impact) as number} />
            )}
            {proposal.status === 'filed' && proposal.issueUrl && (
              <a
                href={proposal.issueUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-semibold text-info hover:underline"
              >
                opened as #{proposal.issueNumber} ↗
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
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#D97757]/30 bg-[#D97757]/[0.08] pl-2 pr-2.5 text-xs font-medium text-foreground opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:border-[#D97757]/50 hover:bg-[#D97757]/15"
            >
              <ClaudeLogo className="h-4 w-4 text-[#D97757]" />
              Claude
            </button>
          </div>
          {expanded && (
            <div className="mt-2">
              <div className="markdown-preview max-h-[36rem] overflow-auto rounded-md bg-main-surface-primary p-4">
                <Markdown remarkPlugins={[remarkGfm]}>{proposal.body}</Markdown>
              </div>
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
  refinement: { label: 'REF', className: 'text-primary' },
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

/**
 * One refinement verdict: badge, reasoning, optional rewrite preview, and the
 * Apply/Ignore pair. Everything is a recommendation until Apply is pressed —
 * drops dismiss the proposal or close the issue, rewrites update the content.
 */
function VerdictCard({
  verdict,
  busy,
  onResolve,
}: {
  verdict: RefinementVerdict;
  busy: boolean;
  onResolve: (verdictId: string, action: 'apply' | 'reject') => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const resolved = verdict.resolution !== undefined;
  // A plain "keep" needs no decision — there is nothing to execute.
  const actionable = !resolved && (verdict.verdict === 'drop' || verdict.rewrite !== undefined);
  const applyLabel =
    verdict.verdict === 'drop'
      ? verdict.target.kind === 'issue'
        ? `Close #${verdict.target.issueNumber}`
        : 'Dismiss proposal'
      : 'Apply rewrite';

  return (
    <div
      className={`rounded-lg border border-border bg-elevated-secondary p-4 ${
        resolved ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-snug">{verdict.title}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                verdict.verdict === 'drop'
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-success-muted text-success'
              }`}
            >
              {verdict.verdict === 'drop' ? 'DROP' : 'KEEP'}
            </span>
            {verdict.rewrite && (
              <span className="inline-flex items-center rounded-full bg-warning-muted px-2 py-0.5 text-[10px] font-semibold text-warning">
                REWRITE
              </span>
            )}
            {verdict.target.kind === 'issue' &&
              (verdict.target.issueUrl ? (
                <a
                  href={verdict.target.issueUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-info hover:underline"
                >
                  #{verdict.target.issueNumber} ↗
                </a>
              ) : (
                <span className="text-xs font-semibold text-info">
                  #{verdict.target.issueNumber}
                </span>
              ))}
            {verdict.target.kind === 'proposal' && (
              <span className="text-[11px] text-muted-foreground">proposal</span>
            )}
            {resolved && (
              <span className="text-[11px] text-muted-foreground">
                {verdict.resolution === 'applied' ? 'applied' : 'ignored'}
              </span>
            )}
          </div>
          {verdict.reasoning && (
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              {verdict.reasoning}
            </p>
          )}
          {verdict.overlapsWith && verdict.overlapsWith.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Overlaps: {verdict.overlapsWith.join(' · ')}
            </p>
          )}
          {verdict.rewrite && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {expanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                {expanded ? 'Hide suggested rewrite' : 'Show suggested rewrite'}
              </button>
              {expanded && (
                <div className="markdown-preview mt-2 max-h-[36rem] overflow-auto rounded-md bg-main-surface-primary p-4">
                  <div className="mb-2 text-sm font-semibold">{verdict.rewrite.title}</div>
                  <Markdown remarkPlugins={[remarkGfm]}>{verdict.rewrite.body}</Markdown>
                </div>
              )}
            </div>
          )}
        </div>
        {actionable && (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onResolve(verdict.id, 'apply')}
              className={`inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 ${
                verdict.verdict === 'drop' ? 'bg-destructive' : 'bg-primary'
              }`}
            >
              {applyLabel}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onResolve(verdict.id, 'reject')}
              className="inline-flex h-7 items-center rounded-md border border-border bg-elevated-secondary px-2.5 text-xs font-medium hover:bg-background-hover disabled:opacity-50"
            >
              Ignore
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The latest refinement pass: status, live log, and the verdict list. Plain
 * "keep" verdicts collapse into a one-line summary — only verdicts that need
 * a decision (drops and rewrites) get cards.
 */
function RefinementSection({
  pass,
  busy,
  onResolve,
}: {
  pass: RefinementPass;
  busy: boolean;
  onResolve: (passId: string, verdictId: string, action: 'apply' | 'reject') => void;
}) {
  const actionable = pass.verdicts.filter(
    (v) => v.verdict === 'drop' || v.rewrite !== undefined
  );
  const plainKeeps = pass.verdicts.length - actionable.length;

  return (
    <section>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Refinement · {new Date(pass.startedAt).toLocaleString()} · {pass.status}
        {pass.status === 'complete' && ` · ${pass.verdicts.length} items reviewed`}
      </div>
      {pass.status === 'running' && (
        <p className="mb-2 text-sm text-muted-foreground">
          The PE and PM agents are re-checking every open proposal against the current code — this
          takes a few minutes…
        </p>
      )}
      {pass.status === 'failed' &&
        (pass.error?.startsWith('Cancelled') ? (
          <p className="mb-2 text-sm text-muted-foreground">Refinement cancelled</p>
        ) : (
          <p className="mb-2 text-sm text-destructive">Refinement failed: {pass.error}</p>
        ))}
      <PassLog logs={pass.logs ?? []} running={pass.status === 'running'} />
      {pass.status === 'complete' && (
        <div className="flex flex-col gap-2">
          {plainKeeps > 0 && (
            <p className="text-xs text-muted-foreground">
              {plainKeeps} item{plainKeeps === 1 ? '' : 's'} confirmed still valid as written.
            </p>
          )}
          {actionable.map((verdict) => (
            <VerdictCard
              key={verdict.id}
              verdict={verdict}
              busy={busy}
              onResolve={(verdictId, action) => onResolve(pass.id, verdictId, action)}
            />
          ))}
          {actionable.length === 0 && (
            <p className="text-sm text-muted-foreground">
              The backlog holds up — nothing to drop or rewrite.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

type ProposalStatus = PlanningProposal['status'];

const STATUS_FILTER_STORAGE_KEY = 'orchestrator-planning-hidden-statuses';

const STATUS_FILTERS: { status: ProposalStatus; label: string; dot: string }[] = [
  { status: 'pending', label: 'Pending', dot: 'bg-primary' },
  { status: 'filed', label: 'Filed', dot: 'bg-info' },
  { status: 'dismissed', label: 'Dismissed', dot: 'bg-muted-foreground' },
];

/**
 * Statuses hidden from the board. Filed and dismissed proposals are already
 * decided, so they start hidden and the board opens on what still needs a call;
 * the choice persists (same lazy-read-at-init pattern as the repo selection).
 */
function readHiddenStatuses(): ReadonlySet<ProposalStatus> {
  const fallback: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(['filed', 'dismissed']);
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(STATUS_FILTER_STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return new Set(
      parsed.filter((value): value is ProposalStatus =>
        STATUS_FILTERS.some((filter) => filter.status === value)
      )
    );
  } catch {
    return fallback;
  }
}

export function PlanningPage() {
  const { current, loaded: reposLoaded } = useRepo();
  const repoId = current?.id ?? null;
  const [passes, setPasses] = useState<PlanningPass[]>([]);
  const [refinementPasses, setRefinementPasses] = useState<RefinementPass[]>([]);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [filingPassId, setFilingPassId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  /** Planning config, to gate the run buttons on PE/PM assignment. */
  const [cfg, setCfg] = useState<PlanningConfig | null>(null);
  // Pending dismissal awaiting an optional reason (fed back into planning memory).
  const [dismissing, setDismissing] = useState<{ passId: string; ids: string[] } | null>(null);
  const [dismissReason, setDismissReason] = useState('');
  const [hidden, setHidden] = useState<ReadonlySet<ProposalStatus>>(readHiddenStatuses);
  const [steeringOpen, setSteeringOpen] = useState(false);
  const [discussing, setDiscussing] = useState<{ passId: string; proposalId: string } | null>(
    null
  );

  const refresh = useCallback(() => {
    if (!repoId) return;
    getPlanning(repoId)
      .then((data) => {
        setPasses(data.passes);
        setRefinementPasses(data.refinementPasses ?? []);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [repoId]);

  // Reset during render when the selected repo changes (React's derived-state
  // pattern), so the effect below only refetches.
  const [loadedRepoId, setLoadedRepoId] = useState(repoId);
  if (loadedRepoId !== repoId) {
    setLoadedRepoId(repoId);
    setPasses([]);
    setRefinementPasses([]);
    setRefineError(null);
    setSelected(new Set());
    setDiscussing(null);
    setSteeringOpen(false);
    setLoaded(false);
  }

  useEffect(refresh, [refresh]);

  const latest = passes[0];
  const running = latest?.status === 'running';
  const refining = refinementPasses[0]?.status === 'running';
  // The latest refinement pass always shows; older ones stay visible only while
  // they still hold unresolved drop/rewrite verdicts, so a newer (e.g. failed)
  // pass can't strand pending decisions.
  const visibleRefinements = refinementPasses.filter(
    (pass, index) =>
      index === 0 ||
      (pass.status === 'complete' &&
        pass.verdicts.some(
          (v) => !v.resolution && (v.verdict === 'drop' || v.rewrite !== undefined)
        ))
  );

  // Poll while a planning or refinement pass is running.
  useEffect(() => {
    if (!running && !refining) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [running, refining, refresh]);

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

  const toggleStatus = (status: ProposalStatus) => {
    const next = new Set(hidden);
    if (next.has(status)) {
      next.delete(status);
    } else {
      next.add(status);
      // Only pending proposals are selectable, so hiding them would otherwise
      // leave an invisible selection armed for the next Create/Dismiss.
      if (status === 'pending') setSelected(new Set());
    }
    setHidden(next);
    try {
      localStorage.setItem(STATUS_FILTER_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // localStorage unavailable — the filter still applies for this session.
    }
  };

  // Badge counts span every pass, so they stay a full picture of the board even
  // when the passes themselves are filtered down to nothing.
  const statusCounts = passes.reduce(
    (acc, pass) => {
      for (const proposal of pass.proposals) acc[proposal.status] += 1;
      return acc;
    },
    { pending: 0, filed: 0, dismissed: 0 } as Record<ProposalStatus, number>
  );
  const totalProposals = statusCounts.pending + statusCounts.filed + statusCounts.dismissed;
  const hiddenCount = [...hidden].reduce((sum, status) => sum + statusCounts[status], 0);

  useEffect(() => {
    if (!repoId) return;
    getPlanningConfig(repoId).then(setCfg).catch(() => setCfg(null));
  }, [repoId]);

  /** The pass refuses to run without BOTH planning agents assigned (no defaults). */
  const agentsAssigned = Boolean(cfg?.peAgent && cfg?.pmAgent);

  // Scheduled-style manual run: no roles (server falls back to the configured
  // scope) and NOT ad-hoc — only the chat drawer runs ad-hoc passes.
  const handleStart = () => {
    if (!repoId || !agentsAssigned) return;
    setBusy(true);
    startPlanningPass(repoId)
      .then(refresh)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  /** Ad-hoc pass from the chat drawer — carries the transcript's direction. */
  const handleAdHocStart = () => {
    if (!repoId || !agentsAssigned) return;
    setBusy(true);
    startPlanningPass(repoId, { adHoc: true })
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

  /** Refinement reuses the assigned PE/PM planning agents, so it needs them too. */
  const handleRefine = () => {
    if (!repoId) return;
    setBusy(true);
    setRefineError(null);
    startRefinementPass(repoId)
      .then(refresh)
      .catch((err) =>
        setRefineError(err instanceof Error ? err.message : 'Could not start the refinement pass')
      )
      .finally(() => setBusy(false));
  };

  const handleRefineCancel = () => {
    if (!repoId) return;
    setCancelling(true);
    cancelRefinementPass(repoId)
      .then(refresh)
      .catch(() => {})
      .finally(() => setCancelling(false));
  };

  /** Apply or ignore one verdict; applying may dismiss a proposal or close an issue. */
  const handleResolveVerdict = (passId: string, verdictId: string, action: 'apply' | 'reject') => {
    if (!repoId) return;
    setBusy(true);
    setRefineError(null);
    resolveRefinementVerdict(repoId, passId, verdictId, action)
      .then(refresh)
      .catch((err) =>
        // Applying mutates GitHub — a failure (auth, already closed) must not look like success.
        setRefineError(err instanceof Error ? err.message : 'Could not apply the verdict')
      )
      .finally(() => setBusy(false));
  };

  const act = (
    action: (repoId: string, passId: string, ids: string[]) => Promise<void>,
    pass: PlanningPass,
    isFiling = false,
  ) => {
    if (!repoId) return;
    const ids = selectedIdsIn(pass);
    if (ids.length === 0) return;
    setBusy(true);
    if (isFiling) setFilingPassId(pass.id);
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
      .finally(() => {
        setBusy(false);
        setFilingPassId(null);
      });
  };

  /** Confirm a pending dismissal, recording the optional reason into planning memory. */
  const confirmDismiss = () => {
    if (!repoId || !dismissing) return;
    const { passId, ids } = dismissing;
    setBusy(true);
    dismissPlanningProposals(repoId, passId, ids, dismissReason.trim() || undefined)
      .then(() =>
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(`${passId}:${id}`);
          return next;
        })
      )
      .then(refresh)
      .catch(() => {})
      .finally(() => {
        setBusy(false);
        setDismissing(null);
        setDismissReason('');
      });
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

  return (
    <div className="flex items-start gap-6 p-6">
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-sm font-bold">Planning</h1>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setSteeringOpen((v) => !v);
              setDiscussing(null); // one drawer at a time
            }}
            aria-pressed={steeringOpen}
            title="Ad-hoc planning with Claude"
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border pl-2 pr-3 text-xs font-medium transition-colors ${
              steeringOpen
                ? 'border-[#D97757]/50 bg-[#D97757]/15'
                : 'border-[#D97757]/30 bg-[#D97757]/[0.08] hover:border-[#D97757]/50 hover:bg-[#D97757]/15'
            }`}
          >
            <ClaudeLogo className="h-[18px] w-[18px] text-[#D97757]" />
            Claude
          </button>
          <button
            type="button"
            disabled={busy || refining || !agentsAssigned}
            onClick={handleRefine}
            title={
              agentsAssigned
                ? 'The PE and PM agents re-check every open proposal against the current code'
                : 'Assign the PE and PM planning agents first'
            }
            className="inline-flex h-8 items-center rounded-md border border-border bg-elevated-secondary px-4 text-xs font-semibold tracking-wide hover:bg-background-hover disabled:opacity-50"
          >
            {refining ? 'Refining…' : 'Refine'}
          </button>
          <button
            type="button"
            disabled={busy || running || !agentsAssigned}
            onClick={handleStart}
            title={agentsAssigned ? undefined : 'Assign the PE and PM planning agents first'}
            className="inline-flex h-8 items-center rounded-md bg-primary px-4 text-xs font-semibold tracking-wide text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {running ? 'Planning…' : 'Plan'}
          </button>
          {(running || refining) && (
            <button
              type="button"
              disabled={cancelling}
              onClick={running ? handleCancel : handleRefineCancel}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-elevated-secondary px-3 text-xs font-medium hover:bg-background-hover disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </div>
      </div>

      {cfg !== null && !agentsAssigned && (
        <div className="rounded-lg border border-warning/40 bg-warning-muted/40 px-4 py-3 text-[13px] leading-relaxed">
          <div className="font-semibold">Planning is disabled. Agents are not set.</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
            {!cfg.peAgent && <li>No Principal Engineer agent assigned</li>}
            {!cfg.pmAgent && <li>No Product Manager agent assigned</li>}
          </ul>
          <a
            href={`/settings?repo=${encodeURIComponent(repoId ?? '')}&tab=agents`}
            className="mt-2 inline-block font-medium underline underline-offset-2 hover:opacity-80"
          >
            Assign them in Settings → Agents
          </a>
        </div>
      )}

      {refineError && (
        <div className="rounded-lg border border-warning/40 bg-warning-muted/40 px-4 py-3 text-[13px] leading-relaxed">
          {refineError}
        </div>
      )}

      {visibleRefinements.map((pass) => (
        <RefinementSection
          key={pass.id}
          pass={pass}
          busy={busy}
          onResolve={handleResolveVerdict}
        />
      ))}

      {passes.length === 0 && (
        <p className="text-sm text-muted-foreground">No planning passes yet — run the first one.</p>
      )}

      {totalProposals > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map(({ status, label, dot }) => {
            const showing = !hidden.has(status);
            return (
              <button
                key={status}
                type="button"
                onClick={() => toggleStatus(status)}
                aria-pressed={showing}
                title={`${showing ? 'Hide' : 'Show'} ${label.toLowerCase()} proposals`}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors ${
                  showing
                    ? 'border-border bg-elevated-secondary text-foreground hover:bg-background-hover'
                    : 'border-dashed border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${dot} ${showing ? '' : 'opacity-40'}`} />
                {label}
                <span
                  className={`rounded-full px-1.5 py-px text-[10px] tabular-nums text-muted-foreground ${
                    showing ? 'bg-background-hover' : ''
                  }`}
                >
                  {statusCounts[status]}
                </span>
              </button>
            );
          })}
          {hiddenCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {hiddenCount} hidden
            </span>
          )}
        </div>
      )}

      {totalProposals > 0 && hiddenCount === totalProposals && (
        <p className="text-sm text-muted-foreground">
          Every proposal is hidden by the filters above.
        </p>
      )}

      {passes.map((pass) => {
        const visible = pass.proposals.filter((p) => !hidden.has(p.status));
        // A finished pass whose every proposal is filtered out drops off the
        // board entirely — the badge counts above say what's being held back.
        if (pass.status === 'complete' && pass.proposals.length > 0 && visible.length === 0) {
          return null;
        }
        const pendingCount = visible.filter((p) => p.status === 'pending').length;
        const selectedCount = selectedIdsIn(pass).length;
        return (
          <section key={pass.id}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {new Date(pass.startedAt).toLocaleString()} · {pass.status}
                {pass.status === 'complete' &&
                  (visible.length === pass.proposals.length
                    ? ` · ${pass.proposals.length} proposals`
                    : ` · ${visible.length} of ${pass.proposals.length} proposals`)}
              </span>
              {pendingCount > 0 && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy || selectedCount === 0}
                    onClick={() => act(filePlanningProposals, pass, true)}
                    className="inline-flex h-7 min-w-24 items-center justify-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {filingPassId === pass.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        Create {selectedCount || ''} issue{selectedCount === 1 ? '' : 's'}
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={busy || selectedCount === 0}
                    onClick={() => {
                      const ids = selectedIdsIn(pass);
                      if (ids.length === 0) return;
                      setDismissReason('');
                      setDismissing({ passId: pass.id, ids });
                    }}
                    className="inline-flex h-7 items-center rounded-md border border-border bg-elevated-secondary px-2.5 text-xs font-medium hover:bg-background-hover disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
            {dismissing?.passId === pass.id && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-elevated-secondary p-2">
                <input
                  autoFocus
                  value={dismissReason}
                  onChange={(e) => setDismissReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmDismiss();
                    if (e.key === 'Escape') setDismissing(null);
                  }}
                  placeholder={`Why dismiss ${dismissing.ids.length}? (optional — teaches future planning)`}
                  maxLength={200}
                  className="h-7 flex-1 rounded-md border border-border bg-main-surface-primary px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={confirmDismiss}
                  className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  onClick={() => setDismissing(null)}
                  className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            )}
            {pass.status === 'running' && (
              <p className="text-sm text-muted-foreground">
                {runningAgentsLabel(pass.roles)} scanning the repo — this takes a few minutes…
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
              {visible.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  selected={selected.has(`${pass.id}:${proposal.id}`)}
                  onToggle={() => toggle(pass.id, proposal.id)}
                  onDiscuss={() => {
                    setDiscussing({ passId: pass.id, proposalId: proposal.id });
                    setSteeringOpen(false); // one drawer at a time
                  }}
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
      {repoId && steeringOpen && !discussing && (
        <PlanningSteeringChat
          repoId={repoId}
          onPlan={handleAdHocStart}
          planning={running}
          canPlan={!busy && agentsAssigned}
          onClose={() => setSteeringOpen(false)}
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
