'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/lib/types';

const BUTTONS: { action: string; label: string; primary?: boolean; danger?: boolean }[] = [
  { action: 'connect-bank', label: 'Connect sandbox bank' },
  { action: 'add-purchase', label: 'Add sandbox purchase' },
  { action: 'sync', label: 'Sync now' },
  { action: 'audit', label: 'Run audit now', primary: true },
  { action: 'digest', label: 'Send digest' },
  { action: 'reset', label: 'Reset demo', danger: true },
];

type Shown = ActionResult & { label: string };

export default function DemoBar({ userId, canReset, mockMode }: { userId: string; canReset: boolean; mockMode: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Shown | null>(null);
  const [refreshing, startRefresh] = useTransition();

  async function run(action: string, label: string) {
    if (action === 'reset' && !window.confirm(`Reset the demo? This deletes and reseeds all of ${userId}'s data.`)) return;
    setBusy(action);
    setResult(null);
    let r: ActionResult;
    try {
      const res = await fetch(`/api/demo/${action}`, { method: 'POST' });
      r = (await res.json()) as ActionResult;
    } catch (err) {
      r = { ok: false, simulated: false, message: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    setBusy(null);
    setResult({ ...r, label });
    // Re-fetch page data once (no polling). Only when something may have changed.
    if (r.ok && !r.simulated) startRefresh(() => router.refresh());
  }

  const tone = !result ? undefined : !result.ok ? 'bad' : result.simulated ? 'warn' : 'ok';

  return (
    <div className="demobar" role="region" aria-label="Demo controls">
      <div className="container demobar-inner">
        <span className="demobar-label">Demo · {userId}</span>
        <div className="demobar-buttons">
        {BUTTONS.map((b) => {
          const disabled = busy !== null || (b.action === 'reset' && !canReset);
          return (
            <button
              key={b.action}
              type="button"
              className={`btn${b.primary ? ' btn-primary' : ''}${b.danger ? ' btn-danger' : ''}`}
              disabled={disabled}
              aria-busy={busy === b.action}
              title={b.action === 'reset' && !canReset ? 'Reset only reseeds maya' : undefined}
              onClick={() => run(b.action, b.label)}
            >
              {busy === b.action ? 'Working…' : b.label}
            </button>
          );
        })}
        </div>
        {mockMode && <span className="small muted">Mock mode: buttons don&apos;t call n8n</span>}
        {(result || refreshing) && (
          <div className="demobar-result" data-tone={tone} role="status" aria-live="polite">
            {result && (
              <>
                <strong>{result.label}</strong>
                <span>{result.message}</span>
              </>
            )}
            {refreshing && <span className="muted">Refreshing data…</span>}
            {result?.offerManual && (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => run('log-expense', 'Log manual expense')}
              >
                Log it as a manual expense instead
              </button>
            )}
            {result?.raw !== undefined && (
              <details>
                <summary className="small muted">Response</summary>
                <pre>{JSON.stringify(result.raw, null, 2)}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
