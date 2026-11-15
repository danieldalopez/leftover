import type { Metadata } from 'next';
import SourceBadge from '@/components/SourceBadge';
import SettingsForm from './SettingsForm';
import { getSettings, isMockMode } from '@/lib/n8n';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const { data, source } = await getSettings();
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">The rules the Sunday audit follows. You set them; the automation stays inside them.</p>
        </div>
        <SourceBadge source={source} />
      </div>
      <SettingsForm initial={data} mockMode={isMockMode()} sourceIsMock={source.kind === 'mock'} />
    </div>
  );
}
