import { Suspense } from 'react';

import { SettingsPage } from '@/components/settings-page';

export default function Settings() {
  // Suspense boundary: SettingsPage reads useSearchParams() for ?tab= deep links.
  return (
    <Suspense>
      <SettingsPage />
    </Suspense>
  );
}
