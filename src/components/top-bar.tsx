'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CircleHelp, Settings } from 'lucide-react';

import { countActiveSessions, getPlanning } from '@/components/shared/task-actions';
import { useOverview } from '@/components/shared/use-overview';
import { useRepo } from '@/components/shared/use-repo';
import { useTasks } from '@/components/shared/use-tasks';

const NAV_ITEMS = [
  { href: '/board', label: 'Board' },
  { href: '/planning', label: 'Planning' },
  { href: '/settings', label: 'Settings' },
] as const;

function isActive(href: string, pathname: string): boolean {
  if (href === '/board') return pathname === '/board' || pathname.startsWith('/issues');
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Fleet-wide chip on the overview: agents running + repos with live sessions. */
function FleetChip() {
  const { repos } = useOverview();
  const agents = repos.reduce((sum, repo) => sum + repo.sessions.length, 0);
  const activeRepos = repos.filter((repo) => repo.sessions.length > 0).length;
  return (
    <span className="inline-flex items-center justify-center rounded-full border border-transparent bg-info-muted px-2.5 py-1 text-xs font-medium text-info">
      {agents} agent{agents === 1 ? '' : 's'} running · {activeRepos} repo
      {activeRepos === 1 ? '' : 's'} active
    </span>
  );
}

/** Selected-repo chip on repo pages: its live sessions + a running planning pass. */
function RepoChip() {
  const { current } = useRepo();
  const { tasks } = useTasks();
  const activeSessions = countActiveSessions(tasks);
  const [planningRunning, setPlanningRunning] = useState(false);

  // Reset during render when the repo changes (derived-state pattern).
  const [planningRepoId, setPlanningRepoId] = useState<string | null>(null);
  if ((current?.id ?? null) !== planningRepoId) {
    setPlanningRepoId(current?.id ?? null);
    setPlanningRunning(false);
  }

  // Planning sessions aren't tasks, so the chip polls the selected repo's
  // latest pass to reflect a running planning pass too.
  useEffect(() => {
    if (!current) return;
    const repoId = current.id;
    let cancelled = false;
    const check = () => {
      getPlanning(repoId)
        .then((data) => {
          if (!cancelled) setPlanningRunning(data.passes[0]?.status === 'running');
        })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [current]);

  return (
    <span className="inline-flex items-center justify-center rounded-full border border-transparent bg-info-muted px-2.5 py-1 text-xs font-medium text-info">
      {activeSessions} agent{activeSessions === 1 ? '' : 's'} running
      {planningRunning && ' · planning'}
    </span>
  );
}

/** Repo-scoped bar contents: the selected repo's name + Board/Planning/Settings. */
function RepoNav({ pathname }: { pathname: string }) {
  const { current } = useRepo();
  return (
    <>
      <div className="h-5 w-px bg-border" aria-hidden />
      <span className="max-w-44 truncate text-sm font-semibold">{current?.name ?? '…'}</span>
      <nav className="flex items-center gap-1">
        {NAV_ITEMS.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={`inline-flex h-8 items-center rounded-md px-3 text-sm font-medium ${
              isActive(href, pathname)
                ? 'bg-background-hover text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}

/**
 * Two modes keyed on the route: global pages (the overview `/` and `/help`) are
 * fleet-scoped — brand plus fleet totals, no nav. Everything else is
 * repo-scoped: the selected repo's name, its Board/Planning/Settings nav, and
 * its own chip. Repo switching happens on the overview, so there is no repo
 * dropdown here.
 */
/** Icon link in the top bar's global controls (App settings, Help). */
function GlobalIconLink({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-border ${
        active
          ? 'bg-background-hover text-foreground'
          : 'bg-elevated-secondary text-muted-foreground hover:bg-background-hover hover:text-foreground'
      }`}
    >
      {children}
    </Link>
  );
}

export function TopBar() {
  const pathname = usePathname();
  const globalPage = pathname === '/' || pathname === '/help' || pathname === '/app-settings';

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-main-surface-primary">
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-5 px-5 py-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2.5 hover:opacity-80">
            {/* Cropped from the full logo art; the cream plate is part of the
                mark, so it keeps a rounded tile on both themes. */}
            <Image
              src="/hydra-mark.png"
              alt=""
              width={160}
              height={99}
              priority
              className="h-8 w-auto rounded-md"
            />
            <span className="text-sm font-bold">Claude Hydra</span>
          </Link>
          {!globalPage && <RepoNav pathname={pathname} />}
        </div>
        <div className="flex items-center gap-3">
          {globalPage ? <FleetChip /> : <RepoChip />}
          <GlobalIconLink
            href="/app-settings"
            label="App settings"
            active={pathname === '/app-settings'}
          >
            <Settings className="h-4 w-4" />
          </GlobalIconLink>
          <GlobalIconLink href="/help" label="How Hydra works" active={pathname === '/help'}>
            <CircleHelp className="h-4 w-4" />
          </GlobalIconLink>
        </div>
      </div>
    </header>
  );
}
