'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { RepoInfo } from '@/lib/types';

const REPO_STORAGE_KEY = 'orchestrator-repo';

interface RepoContextValue {
  /** All registered repos from GET /api/repos. */
  repos: RepoInfo[];
  /** The selected repo — null until loaded, or when none are registered. */
  current: RepoInfo | null;
  /** True once GET /api/repos has resolved (success or failure) at least once. */
  loaded: boolean;
  select: (id: string) => void;
  /** Register a repo by absolute path; rejects with the API's validation message. */
  addRepo: (path: string, name?: string) => Promise<RepoInfo>;
  refresh: () => Promise<void>;
}

const RepoContext = createContext<RepoContextValue | null>(null);

/** Initial selection: deep-link `?repo=` wins, then the persisted choice. */
function readInitialSelection(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return (
      new URLSearchParams(window.location.search).get('repo') ??
      localStorage.getItem(REPO_STORAGE_KEY)
    );
  } catch {
    return null;
  }
}

export function RepoProvider({ children }: { children: React.ReactNode }) {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(readInitialSelection);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/repos');
    if (!res.ok) throw new Error(`GET /api/repos failed with ${res.status}`);
    setRepos((await res.json()) as RepoInfo[]);
  }, []);

  useEffect(() => {
    fetch('/api/repos')
      .then((res) =>
        res.ok ? (res.json() as Promise<RepoInfo[]>) : Promise.reject(new Error(`${res.status}`)),
      )
      .then((list) => setRepos(list))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const select = useCallback((id: string) => {
    if (!id) return;
    setSelectedId(id);
    try {
      localStorage.setItem(REPO_STORAGE_KEY, id);
    } catch {
      // localStorage unavailable — selection still applies for this session.
    }
  }, []);

  const addRepo = useCallback(
    async (path: string, name?: string) => {
      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, ...(name?.trim() ? { name: name.trim() } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as
        | (RepoInfo & { error?: string })
        | { error?: string }
        | null;
      if (!res.ok) {
        throw new Error(body?.error ?? `POST /api/repos failed with ${res.status}`);
      }
      const repo = body as RepoInfo;
      setRepos((prev) =>
        prev.some((candidate) => candidate.id === repo.id)
          ? prev.map((candidate) => (candidate.id === repo.id ? repo : candidate))
          : [...prev, repo],
      );
      select(repo.id);
      return repo;
    },
    [select],
  );

  // Fall back to the first repo when nothing (valid) is selected.
  const current = useMemo(
    () => repos.find((candidate) => candidate.id === selectedId) ?? repos[0] ?? null,
    [repos, selectedId],
  );

  const value = useMemo(
    () => ({ repos, current, loaded, select, addRepo, refresh }),
    [repos, current, loaded, select, addRepo, refresh],
  );

  return <RepoContext.Provider value={value}>{children}</RepoContext.Provider>;
}

export function useRepo(): RepoContextValue {
  const ctx = useContext(RepoContext);
  if (!ctx) throw new Error('useRepo must be used within a RepoProvider');
  return ctx;
}

