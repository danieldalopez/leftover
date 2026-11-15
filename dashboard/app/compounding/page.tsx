import type { Metadata } from 'next';
import SourceBadge from '@/components/SourceBadge';
import CompoundingView from './CompoundingView';
import { getProjection } from '@/lib/n8n';

export const metadata: Metadata = { title: 'Compounding' };

export default async function CompoundingPage({ searchParams }: { searchParams: Promise<{ rate?: string }> }) {
  const { rate } = await searchParams;
  const safeRate = rate && /^0\.\d{1,3}$/.test(rate) ? rate : '0.06';
  const { data, source } = await getProjection(safeRate);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Compounding</h1>
          <p className="sub">What your leftovers could grow into. Illustrative only.</p>
        </div>
        <SourceBadge source={source} />
      </div>
      <CompoundingView data={data} />
    </div>
  );
}
