import type { Metadata } from 'next';
import SourceBadge from '@/components/SourceBadge';
import HistoryView from './HistoryView';
import { getAudits } from '@/lib/n8n';

export const metadata: Metadata = { title: 'History' };

export default async function HistoryPage() {
  const { data, source } = await getAudits();
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>History</h1>
          <p className="sub">Every Sunday audit: what was left over, what went to the cushion, what was invested.</p>
        </div>
        <SourceBadge source={source} />
      </div>
      <HistoryView data={data} />
    </div>
  );
}
