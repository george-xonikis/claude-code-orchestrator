import type { Metadata } from 'next';

import { HelpPage } from '@/components/help-page';

export const metadata: Metadata = { title: 'How Hydra works — Claude Hydra' };

export default function HelpRoute() {
  return (
    <main>
      <HelpPage />
    </main>
  );
}
