'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/reviews', label: 'Reviews' },
  { href: '/installations', label: 'Installations' },
];

/** The rail: three places, and the current one marked for sight and for screen readers. */
export function Nav() {
  const path = usePathname();
  const current = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  return (
    <nav aria-label="Dashboard" className="md:w-40 md:shrink-0">
      <p className="mb-4 text-[17px] font-bold tracking-tight text-ink">pr-reviewer</p>
      <ul className="flex gap-5 md:flex-col md:gap-1">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              aria-current={current(l.href) ? 'page' : undefined}
              className={`block py-1 no-underline md:border-l-2 md:pl-3 ${
                current(l.href) ? 'font-bold text-ink md:border-accent' : 'text-muted hover:text-ink md:border-transparent'
              }`}
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
