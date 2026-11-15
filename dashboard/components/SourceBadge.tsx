import type { Source } from '@/lib/types';

const REASON: Record<string, string> = {
  'mock-mode': 'mock mode',
  unreachable: 'n8n unreachable',
  error: 'API error',
  shape: 'unexpected shape',
};

/** Always visible on a page: says whether its numbers are live from n8n or contract fixtures. */
export default function SourceBadge({ source }: { source: Source }) {
  if (source.kind === 'live') {
    return (
      <span className="badge badge-live" title="Live from n8n (LO-08 Dashboard API)">
        <span className="dot" aria-hidden /> Live from n8n
      </span>
    );
  }
  return (
    <span className="badge badge-mock" title={source.detail} role="status">
      <span className="dot" aria-hidden /> Mock data
      <span className="badge-detail">· {REASON[source.reason] ?? source.reason}</span>
    </span>
  );
}
