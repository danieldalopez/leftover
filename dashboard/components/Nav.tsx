'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'This week' },
  { href: '/history', label: 'History' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/compounding', label: 'Compounding' },
  { href: '/settings', label: 'Settings' },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Pages">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={path === l.href ? 'page' : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
