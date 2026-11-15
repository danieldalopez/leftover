'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/lib/types';

interface DemoButton {
  action: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

/** The three steps of the demo, in order. */
const MAIN: DemoButton[] = [
  { action: 'add-purchase', label: 'Add sandbox purchase' },
  { action: 'audit', label: 'Run audit now', primary: true },
  { action: 'digest', label: 'Send digest' },
];
const MORE: DemoButton[] = [
  { action: 'connect-bank', label: 'Connect sandbox bank' },
  { action: 'sync', label: 'Sync now' },
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

  const button = (b: DemoButton) => (
    <button
      key={b.action}
      type="button"
      className={`btn${b.primary ? ' btn-primary' : ''}${b.danger ? ' btn-danger' : ''}`}
      disabled={busy !== null || (b.action === 'reset' && !canReset)}
      aria-busy={busy === b.action}
      title={b.action === 'reset' && !canReset ? 'Reset only reseeds maya' : undefined}
      onClick={() => run(b.action, b.label)}
    >
      {busy === b.action ? 'Working…' : b.label}
    </button>
  );

  return (
    <div className="demobar" role="region" aria-label="Demo controls">
      <div className="container demobar-inner">
        <span className="demobar-label">Demo · {userId}</span>
        <div className="demobar-buttons">
          {MAIN.map(button)}
          <details className="more">
            <summary>More</summary>
            {MORE.map(button)}
          </details>
        </div>
        {mockMode && <span className="demobar-label">Mock mode: buttons don&apos;t call n8n</span>}
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
            {result?.email && (
              <div className="email">
                <div className="email-subject">{result.email.subject}</div>
                {result.email.body.split('\n\n').map((block, i) =>
                  i === 0 ? <p key={i}>{block}</p> : <pre key={i}>{block}</pre>,
                )}
              </div>
            )}
            {result?.raw !== undefined && (
              <details>
                <summary className="small">Response</summary>
                <pre>{JSON.stringify(result.raw, null, 2)}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
