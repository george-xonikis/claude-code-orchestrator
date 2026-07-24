'use client';

import { useCallback, useSyncExternalStore } from 'react';

import { Switch } from '@/components/shared/switch';

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

/** Light/dark switch. State lives on <html data-theme>, persisted to localStorage. */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => 'light' as Theme);

  const setTheme = useCallback((next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // localStorage unavailable — theme still flips for this session.
    }
  }, []);

  return (
    <Switch
      checked={theme === 'dark'}
      onChange={(on) => setTheme(on ? 'dark' : 'light')}
      label="Dark mode"
    />
  );
}
