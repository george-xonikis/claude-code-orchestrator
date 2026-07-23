'use client';

import { useCallback, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Moon, Sun } from 'lucide-react';

import { countActiveSessions } from '@/components/shared/task-actions';
import { useTasks } from '@/components/shared/use-tasks';

const THEME_STORAGE_KEY = 'orchestrator-theme';

type Theme = 'light' | 'dark';

const NAV_ITEMS = [
  { href: '/', label: 'Board' },
  { href: '/planning', label: 'Planning' },
  { href: '/settings', label: 'Goal' },
] as const;

/** The <html data-theme> attribute is the source of truth (set pre-paint by the init script). */
function subscribeToTheme(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function isActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/issues');
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function TopBar() {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => 'light' as Theme);
  const pathname = usePathname();
  const { tasks } = useTasks();
  const activeSessions = countActiveSessions(tasks);

  const toggleTheme = useCallback(() => {
    const next: Theme = readTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // localStorage unavailable — theme still flips for this session.
    }
  }, []);

  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-main-surface-primary px-5 py-3">
      <div className="flex items-center gap-5">
        <Link href="/" className="text-sm font-bold hover:opacity-80">
          Claude Agents Orchestrator
        </Link>
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
        </span>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-elevated-secondary hover:bg-background-hover"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>
    </header>
  );
}
