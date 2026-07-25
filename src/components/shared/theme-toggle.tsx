'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';

const THEME_STORAGE_KEY = 'orchestrator-theme';

type Theme = 'light' | 'dark';

/** The <html data-theme> attribute is the source of truth (set pre-paint by the init script). */
function subscribeToTheme(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function useTheme(): [Theme, (next: Theme) => void] {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => 'light' as Theme);

  const setTheme = useCallback((next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // localStorage unavailable — theme still flips for this session.
    }
  }, []);

  return [theme, setTheme];
}

/** Top-bar light/dark toggle — the app's only theme control. */
export function ThemeToggleButton() {
  const [theme, setTheme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-elevated-secondary text-muted-foreground hover:bg-background-hover hover:text-foreground"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
