import { Suspense } from 'react';
import type { Metadata } from 'next';

import { AppSettingsPage } from '@/components/app-settings-page';

export const metadata: Metadata = { title: 'App settings — Claude Hydra' };

export default function AppSettings() {
  // Suspense boundary: AppSettingsPage reads useSearchParams() for ?tab= deep links.
  return (
    <Suspense>
      <AppSettingsPage />
    </Suspense>
  );
}
