'use client';

import { useEffect, useState } from 'react';

import { MarkdownEditorSection } from '@/components/shared/markdown-editor-section';
import { getSettings, saveSettings } from '@/components/shared/task-actions';
import { useRepo } from '@/components/shared/use-repo';

export function PreferencesPage() {
  const { current, loaded: reposLoaded } = useRepo();
  const repoId = current?.id ?? null;
  const [memory, setMemory] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Reset during render when the selected repo changes (derived-state pattern).
  const [loadedRepoId, setLoadedRepoId] = useState(repoId);
  if (loadedRepoId !== repoId) {
    setLoadedRepoId(repoId);
    setMemory('');
    setLoaded(false);
  }

  useEffect(() => {
    if (!repoId) return;
    getSettings(repoId)
      .then((settings) => setMemory(settings.memory))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [repoId]);

  if (reposLoaded && !current) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Add a repository on the board to edit its memory.
      </div>
    );
  }

  if (!loaded) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <MarkdownEditorSection
        title="Memory"
        description="Reusable lessons injected into every session. Agents append here via save_memory (stamped with the issue number) — curate freely, delete anything wrong. Stored in .orchestrator/memory.md."
        value={memory}
        minHeightClass="min-h-72 max-h-[36rem]"
        placeholder="- [#312] The pre-commit hook requires all modified backend files staged…"
        onChange={setMemory}
        onSave={() => (repoId ? saveSettings(repoId, { memory }) : Promise.resolve())}
      />
    </div>
  );
}
