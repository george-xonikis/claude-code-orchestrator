import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import { RepoProvider } from '@/components/shared/use-repo';
import { TopBar } from '@/components/top-bar';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Claude Orchestrator',
  description:
    'Local dev tool: run autonomous Claude Code agents against agent-ready GitHub issues.',
};

// Applies the persisted theme before first paint so a dark-mode reload doesn't flash light.
const themeInitScript = `try{var t=localStorage.getItem('orchestrator-theme');if(t==='dark'||t==='light'){document.documentElement.dataset.theme=t;}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="bg-main-surface-primary text-foreground antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <RepoProvider>
          <TopBar />
          <main className="mx-auto w-full max-w-[1600px]">{children}</main>
        </RepoProvider>
      </body>
    </html>
  );
}
