'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Sparkles } from 'lucide-react';

import type { PlanningPass, PlanningProposal } from '@/lib/types';
import { LabelChip } from '@/components/shared/label-chip';
import {
  dismissPlanningProposals,
  filePlanningProposals,
  getPlanning,
  setPlanningInterval,
  startPlanningPass,
} from '@/components/shared/task-actions';

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
}: {
  proposal: PlanningProposal;
  selected: boolean;
  onToggle: () => void;
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
            {(proposal.effort ?? proposal.impact) && (
              <span className="text-[11px] text-muted-foreground">
                {[proposal.effort && `effort ${proposal.effort}`, proposal.impact && `impact ${proposal.impact}`]
                  .filter(Boolean)
                  .join(' · ')}
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
  const [passes, setPasses] = useState<PlanningPass[]>([]);
  const [intervalHours, setIntervalHours] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    getPlanning()
      .then((data) => {
        setPasses(data.passes);
        setIntervalHours(data.intervalHours);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const handleIntervalChange = (value: string) => {
    const hours = value === '' ? null : Number(value);
    setIntervalHours(hours); // optimistic
    setPlanningInterval(hours).catch(() => {});
  };

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
    setBusy(true);
    startPlanningPass()
      .then(refresh)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const act = (action: (passId: string, ids: string[]) => Promise<void>, pass: PlanningPass) => {
    const ids = selectedIdsIn(pass);
    if (ids.length === 0) return;
    setBusy(true);
    action(pass.id, ids)
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

  if (!loaded) {
    return <div className="p-6 text-sm text-muted-foreground">Loading planning passes…</div>;
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
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
            disabled={busy || running}
            onClick={handleStart}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {running ? 'Planning…' : 'Plan'}
          </button>
        </div>
      </div>

      {passes.length === 0 && (
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
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
