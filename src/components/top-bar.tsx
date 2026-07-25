'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Plus } from 'lucide-react';

import { countActiveSessions, getPlanning } from '@/components/shared/task-actions';
import { AddRepoModal } from '@/components/add-repo-modal';
import { useRepo } from '@/components/shared/use-repo';
import { useTasks } from '@/components/shared/use-tasks';

const NAV_ITEMS = [
  { href: '/', label: 'Board' },
  { href: '/planning', label: 'Planning' },
  { href: '/settings', label: 'Settings' },
] as const;

function isActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/issues');
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function TopBar() {
  const pathname = usePathname();
  const { repos, current, select } = useRepo();
  const { tasks } = useTasks();
  const activeSessions = countActiveSessions(tasks);
  const [planningRunning, setPlanningRunning] = useState(false);
  const [addingRepo, setAddingRepo] = useState(false);

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
    <header className="sticky top-0 z-10 border-b border-border bg-main-surface-primary">
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between px-5 py-3">
      <div className="flex items-center gap-5">
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
        <div className="flex items-center gap-1.5">
          <select
            value={current?.id ?? ''}
            onChange={(event) => select(event.target.value)}
            aria-label="Select repository"
            className="h-8 max-w-44 rounded-md border border-border bg-elevated-secondary px-2 text-xs font-medium outline-none focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50"
          >
            {repos.length === 0 && (
              <option value="" disabled>
                No repos
              </option>
            )}
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setAddingRepo(true)}
            aria-label="Add repo"
            title="Add repo"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-elevated-secondary hover:bg-background-hover"
          >
            <Plus className="h-4 w-4" />
          </button>
          {addingRepo && <AddRepoModal onClose={() => setAddingRepo(false)} />}
        </div>
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
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center justify-center rounded-full border border-transparent bg-info-muted px-2.5 py-1 text-xs font-medium text-info">
          {activeSessions} agent{activeSessions === 1 ? '' : 's'} running
          {planningRunning && ' · planning'}
        </span>
      </div>
      </div>
    </header>
  );
}
