import type { Metadata } from 'next';
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next } from 'next/font/google';
import { Nav } from '@/components/nav';
import './globals.css';

// Next has no size-matched fallback metrics for these faces, so name the fallbacks plainly.
const sans = Atkinson_Hyperlegible_Next({ subsets: ['latin'], variable: '--font-atkinson', fallback: ['system-ui', 'sans-serif'], adjustFontFallback: false });
const mono = Atkinson_Hyperlegible_Mono({ subsets: ['latin'], variable: '--font-atkinson-mono', fallback: ['ui-monospace', 'monospace'], adjustFontFallback: false });

export const metadata: Metadata = {
  title: { default: 'pr-reviewer', template: '%s · pr-reviewer' },
  description: 'How the pr-reviewer bot is doing: its reviews, what it posted, and what people thought of it.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-8 px-4 py-6 md:flex-row md:gap-12 md:px-8 md:py-10">
          <Nav />
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
