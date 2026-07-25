'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ArrowRight, Plus } from 'lucide-react';

import type { RepoOverview, TaskStatus } from '@/lib/types';
import { AddRepoModal } from '@/components/add-repo-modal';
import { refreshOverview, useOverview } from '@/components/shared/use-overview';
import { useRepo } from '@/components/shared/use-repo';

/** Distribution bar + legend order and colors (theme tokens, both themes). */
const DISTRO: { status: TaskStatus; label: string; color: string }[] = [
  { status: 'ready', label: 'ready', color: 'var(--color-secondary)' },
  { status: 'working', label: 'working', color: 'var(--color-info)' },
  { status: 'needs_input', label: 'needs input', color: 'var(--color-warning)' },
  { status: 'committed', label: 'committed', color: 'var(--color-primary)' },
  { status: 'pr_open', label: 'PR open', color: 'var(--color-success)' },
  { status: 'failed', label: 'failed', color: 'var(--color-destructive)' },
];

const MAX_SESSION_ROWS = 3;

/** Shorten a home-rooted absolute path for display (~/…). */
function displayPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

/** "claude-fable-5" -> "fable-5" (the claude- prefix is noise at this size). */
function displayModel(model: string): string {
  return model.replace(/^claude-/, '');
}

/** Compact elapsed/idle time: "4m", "2h", "3d". */
function elapsed(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Tiny animated equalizer marking a live working session. */
function Pulse() {
  return (
    <span className="agent-pulse" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

/** Hollow amber ring marking a session waiting on developer input. */
function WaitDot() {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 flex-none rounded-full border-2 border-warning bg-warning-muted"
    />
  );
}

function StatTile({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <div className="min-w-28 rounded-lg border border-border bg-main-surface-primary px-3.5 py-3">
      <div className={`text-2xl font-bold leading-tight tracking-tight ${className ?? ''}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function RepoCard({
  overview,
  isCurrent,
  onOpen,
}: {
  overview: RepoOverview;
  isCurrent: boolean;
  onOpen: () => void;
}) {
  const { repo, counts, sessions, queueCount, autoStart, maxActive, planningRunning, lastActivityAt } =
    overview;
  const live = sessions.length > 0;
  const working = counts.working;
  const total = DISTRO.reduce((sum, { status }) => sum + counts[status], 0);
  const shownSessions = sessions.slice(0, MAX_SESSION_ROWS);
  const hiddenSessions = sessions.length - shownSessions.length;

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen();
      }}
      className={`flex flex-col gap-3 rounded-xl border bg-elevated-secondary p-4 text-left hover:bg-background-hover ${
        isCurrent ? 'border-primary ring-1 ring-primary' : 'border-border'
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={`mt-1.5 h-2 w-2 flex-none rounded-full ${
            live ? 'bg-info ring-[3px] ring-info-muted' : 'bg-muted-foreground opacity-45'
          }`}
        />
        <div className="min-w-0">
          {/* The registry display name (what was typed in Add repo), not the folder name. */}
          <div className="truncate text-sm font-bold tracking-tight">{repo.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {displayPath(repo.path)}
          </div>
        </div>
        <span
          className={`ml-auto inline-flex flex-none items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            autoStart ? 'bg-success-muted text-success' : 'bg-secondary text-secondary-foreground'
          }`}
        >
          {autoStart ? 'Pickup on' : 'Paused'}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-1.5">
          <span
            className={`text-xl font-bold leading-none ${working === 0 ? 'text-muted-foreground' : ''}`}
          >
            {working}
          </span>
          <span className="text-xs text-muted-foreground">
            agent{working === 1 ? '' : 's'} working
            {planningRunning && ' · 1 planning pass'}
            {!live && lastActivityAt && ` · idle ${elapsed(lastActivityAt)}`}
          </span>
        </div>

        {shownSessions.map((session) => (
          <div
            key={session.issueNumber}
            className="flex items-center gap-2 rounded-lg border border-border bg-main-surface-primary px-2 py-1.5 text-xs"
          >
            {session.status === 'working' ? <Pulse /> : <WaitDot />}
            <span className="flex-none font-semibold text-muted-foreground">
              #{session.issueNumber}
            </span>
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            <span className="flex-none text-[11px] text-muted-foreground">
              {session.status === 'needs_input'
                ? 'waiting'
                : [session.startedAt && elapsed(session.startedAt), session.model && displayModel(session.model)]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          </div>
        ))}
        {hiddenSessions > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground">
            <span className="font-semibold">+{hiddenSessions}</span> more running
          </div>
        )}
        {live && queueCount > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground">
            <span className="font-semibold">+{queueCount}</span> ready, queued behind pickup
          </div>
        )}
        {!live && (
          <p className="py-1 text-xs text-muted-foreground">
            Nothing running.{' '}
            {queueCount > 0
              ? `${queueCount} ticket${queueCount === 1 ? '' : 's'} ready to pick up.`
              : 'Queue is empty.'}
          </p>
        )}
      </div>

      <div>
        <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
          {total > 0 &&
            DISTRO.filter(({ status }) => counts[status] > 0).map(({ status, color }) => (
              <span
                key={status}
                style={{ width: `${(counts[status] / total) * 100}%`, backgroundColor: color }}
              />
            ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
          {DISTRO.filter(({ status }) => counts[status] > 0).map(({ status, label, color }) => (
            <span key={status} className="inline-flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-[2px]"
                style={{ backgroundColor: color }}
              />
              {counts[status]} {label}
            </span>
          ))}
          {total === 0 && <span>No tickets on the board yet.</span>}
        </div>
      </div>

      <div className="mt-auto flex items-center gap-2 border-t border-border pt-2.5 text-xs text-muted-foreground">
        <span>
          Queue {queueCount} · cap {maxActive}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 font-semibold text-primary">
          Open board <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </article>
  );
}

export function OverviewPage() {
  const router = useRouter();
  const { current, select } = useRepo();
  const { repos, loaded } = useOverview();
  const [addingRepo, setAddingRepo] = useState(false);

  const openBoard = (repoId: string) => {
    select(repoId);
    router.push('/board');
  };

  const agents = repos.reduce((sum, r) => sum + r.sessions.length, 0);
  const needInput = repos.reduce((sum, r) => sum + r.counts.needs_input, 0);
  const prsOpen = repos.reduce((sum, r) => sum + r.counts.pr_open, 0);

  // Active repos first, then most recent activity — the busy repos stay in reach.
  const ordered = [...repos].sort(
    (a, b) =>
      b.sessions.length - a.sessions.length ||
      (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
  );

  return (
    <div className="p-5">
      <section className="mb-5 flex flex-wrap items-center gap-7 rounded-2xl border border-border bg-elevated-secondary px-6 py-5">
        {/* The full logo art; its cream plate is part of the mark on both themes. */}
        <Image
          src="/hydra-logo.png"
          alt=""
          width={320}
          height={198}
          priority
          className="h-24 w-auto flex-none rounded-lg"
        />
        <div>
          <h1 className="text-xl font-bold tracking-tight">Your fleet</h1>
          <p className="mt-1 max-w-md text-[13px] leading-relaxed text-muted-foreground">
            Every registered repo, the agents running in it right now, and what needs you. Pick a
            repo to jump straight to its board.
          </p>
        </div>
        <div className="ml-auto flex flex-none flex-wrap gap-2.5">
          <StatTile value={agents} label="Agents" className="text-info" />
          <StatTile value={needInput} label="Need input" className="text-warning" />
          <StatTile value={prsOpen} label="PRs open" className="text-success" />
          <StatTile value={repos.length} label="Repos" />
        </div>
      </section>

      <div className="mb-3 flex items-center gap-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Repositories
        </h2>
        <div className="h-px flex-1 bg-border" />
      </div>

      <div className="grid grid-cols-1 gap-3.5 pb-10 md:grid-cols-2 xl:grid-cols-3">
        {ordered.map((overview) => (
          <RepoCard
            key={overview.repo.id}
            overview={overview}
            isCurrent={overview.repo.id === current?.id}
            onOpen={() => openBoard(overview.repo.id)}
          />
        ))}
        {loaded && (
          <button
            type="button"
            onClick={() => setAddingRepo(true)}
            className="flex min-h-52 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-muted-foreground hover:bg-background-hover"
          >
            <Plus className="h-5 w-5" />
            <span className="text-[13px] font-bold text-foreground">Add repository</span>
            <span className="text-[11px]">Register a local git checkout</span>
          </button>
        )}
      </div>

      {addingRepo && (
        <AddRepoModal
          onClose={() => {
            setAddingRepo(false);
            refreshOverview(); // show the new card now, not on the next poll
          }}
        />
      )}
    </div>
  );
}
