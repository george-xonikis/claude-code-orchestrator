'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ScrollText, SlidersHorizontal } from 'lucide-react';

import { PromptTemplateEditors } from '@/components/prompt-template-editors';
import { ThemeToggle } from '@/components/shared/theme-toggle';

/**
 * /app-settings — HYDRA-level settings, as opposed to /settings which is scoped
 * to the selected repo. Same layout as the repo settings page (vertical tabs,
 * tab header, sectioned content). Anything that applies to every managed repo
 * (or to this browser, like the theme) belongs here.
 */

const TABS = [
  {
    value: 'general',
    label: 'General',
    Icon: SlidersHorizontal,
    description: 'App-wide preferences for this browser.',
  },
  {
    value: 'prompts',
    label: 'Prompts',
    Icon: ScrollText,
    description:
      'The exact instructions Hydra launches agent sessions with, applied across every managed repo. Placeholders are filled per session; every other word is yours to rewrite. See the Help page for how the pieces flow together.',
  },
] as const;

type Tab = (typeof TABS)[number]['value'];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-h-8 items-center justify-between gap-4">
      <span className="text-sm font-medium">
        {label}
        {hint && <span className="ml-1 text-muted-foreground">— {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 py-6">
      <h2 className="text-base font-bold text-foreground">{title}</h2>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

export function AppSettingsPage() {
  // Deep link: /app-settings?tab=prompts (used by the Help page).
  const requestedTab = useSearchParams().get('tab');
  const [tab, setTab] = useState<Tab>(
    TABS.some((candidate) => candidate.value === requestedTab) ? (requestedTab as Tab) : 'general'
  );
  const activeTab = TABS.find((t) => t.value === tab);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 p-6 sm:p-8">
      <h1 className="text-2xl font-bold tracking-tight">App settings</h1>

      <div className="flex flex-col gap-8 sm:flex-row">
        <nav
          role="tablist"
          aria-orientation="vertical"
          aria-label="App settings"
          className="flex shrink-0 gap-1 sm:w-56 sm:flex-col sm:border-r sm:border-border sm:pr-6"
        >
          {TABS.map(({ value, label, Icon }) => {
            const active = tab === value;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(value)}
                className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-background-hover hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 divide-y divide-border md:max-w-2xl">
          <header className="pb-5">
            <h2 className="text-2xl font-bold tracking-tight">{activeTab?.label}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{activeTab?.description}</p>
          </header>

          {tab === 'general' && (
            <Section title="Appearance">
              <Row label="Dark mode" hint="applies to this browser">
                <ThemeToggle />
              </Row>
            </Section>
          )}

          {tab === 'prompts' && (
            <div className="py-6">
              <PromptTemplateEditors />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
