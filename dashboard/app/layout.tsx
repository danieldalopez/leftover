import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Jersey_15 } from 'next/font/google';
import './globals.css';
import Nav from '@/components/Nav';
import DemoBar from '@/components/DemoBar';
import { demoUserId, getSummary, isMockMode } from '@/lib/n8n';
import { DISCLAIMER } from '@/lib/constants';

const pixel = Jersey_15({ weight: "400", subsets: ["latin"], variable: '--font-pixel' });

export const metadata: Metadata = {
  title: { default: 'Leftover', template: '%s · Leftover' },
  description: 'Invest what you didn’t spend. Weekly budgets; a Sunday n8n audit invests the leftover (paper trading).',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#fbfbf8',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { data: s } = await getSummary();
  const userId = demoUserId();
  return (
    <html lang="en-CA" className={pixel.variable}>
      <body>
        <header className="topbar">
          <div className="container topbar-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden /> Leftover
            </Link>
            <Nav />
          </div>
        </header>
        {s.demo_mode && <DemoBar userId={userId} canReset={userId === 'maya'} mockMode={isMockMode()} />}
        <main>
          <div className="container">{children}</div>
        </main>
        <footer className="footer">
          <div className="container">
            <p>{DISCLAIMER}</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
