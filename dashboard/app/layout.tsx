import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import Nav from '@/components/Nav';
import DemoBar from '@/components/DemoBar';
import { demoUserId, getSummary, isMockMode } from '@/lib/n8n';
import { cad } from '@/lib/format';
import { DISCLAIMER } from '@/lib/constants';

export const metadata: Metadata = {
  title: { default: 'Leftover', template: '%s · Leftover' },
  description: 'Invest what you didn’t spend. Weekly budgets; a Sunday n8n audit invests the leftover (paper trading).',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcfcfb' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1a19' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { data: s } = await getSummary();
  const userId = demoUserId();
  return (
    <html lang="en-CA">
      <body>
        <header className="topbar">
          <div className="container topbar-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden /> Leftover
            </Link>
            <Nav />
            <div className="header-stats" aria-label="Totals">
              <div>
                Invested so far<strong>{cad(s.lifetime.invested_cad)}</strong>
              </div>
              <div>
                Cushion<strong>{cad(s.buffer.balance_cad)}</strong>
              </div>
              <div>
                Portfolio<strong>{cad(s.portfolio.market_value_cad)}</strong>
              </div>
            </div>
          </div>
        </header>
        {s.demo_mode && <DemoBar userId={userId} canReset={userId === 'maya'} mockMode={isMockMode()} />}
        <main>
          <div className="container">{children}</div>
        </main>
        <footer className="footer">
          <div className="container">
            <p>{DISCLAIMER}</p>
            <p>Leftover · Loop Hackathon prototype · n8n workflows do the work; this page only reads and triggers them.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
