'use client';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cad } from '@/lib/format';
import type { ActionResult, Settings, SettingsUpdate } from '@/lib/types';

interface BudgetDraft {
  category_key: string;
  label: string;
  amount: string;
  active: boolean;
}

function draftFrom(s: Settings) {
  return {
    budgets: s.budgets.map((b) => ({ category_key: b.category_key, label: b.label, amount: String(b.weekly_amount_cad), active: b.active })),
    bufferTarget: String(s.buffer_target_cad),
    cushionPct: String(Math.round(s.cushion_rate * 1000) / 10),
    absorb: s.absorb_overspend,
  };
}

const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

export default function SettingsForm({
  initial,
  mockMode,
  sourceIsMock,
}: {
  initial: Settings;
  mockMode: boolean;
  sourceIsMock: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<Settings>(initial);
  const [draft, setDraft] = useState(() => draftFrom(initial));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null);
  const [, startRefresh] = useTransition();

  const update: SettingsUpdate = useMemo(() => {
    const u: SettingsUpdate = {};
    const changed = draft.budgets.filter((d) => {
      const b = saved.budgets.find((x) => x.category_key === d.category_key);
      return b && (num(d.amount) !== b.weekly_amount_cad || d.active !== b.active);
    });
    if (changed.length) {
      u.budgets = changed.map((d) => ({ category_key: d.category_key, weekly_amount: num(d.amount), active: d.active }));
    }
    if (num(draft.bufferTarget) !== saved.buffer_target_cad) u.buffer_target = num(draft.bufferTarget);
    const rate = Math.round(num(draft.cushionPct) * 10) / 1000;
    if (rate !== saved.cushion_rate) u.cushion_rate = rate;
    if (draft.absorb !== saved.absorb_overspend) u.absorb_overspend = draft.absorb;
    return u;
  }, [draft, saved]);

  const errors = useMemo(() => {
    const e: string[] = [];
    for (const b of draft.budgets) if (!(num(b.amount) >= 0)) e.push(`${b.label}: enter an amount of 0 or more`);
    if (!(num(draft.bufferTarget) >= 0)) e.push('Cushion target: enter 0 or more');
    const c = num(draft.cushionPct);
    if (!(c >= 0 && c <= 100)) e.push('Cushion rate: enter 0 to 100%');
    return e;
  }, [draft]);

  const dirty = Object.keys(update).length > 0;
  const weeklyTotal = draft.budgets.filter((b) => b.active).reduce((s, b) => s + (num(b.amount) || 0), 0);

  async function save(body: SettingsUpdate) {
    setBusy(true);
    setMsg(null);
    let r: ActionResult & { settings?: Settings };
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      r = await res.json();
    } catch (err) {
      r = { ok: false, simulated: false, message: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    setBusy(false);
    setMsg({ tone: !r.ok ? 'bad' : r.simulated ? 'warn' : 'ok', text: r.message });
    if (r.ok && r.settings) {
      setSaved(r.settings);
      setDraft(draftFrom(r.settings));
    }
    if (r.ok && !r.simulated) startRefresh(() => router.refresh());
  }

  const status = saved.status;

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!errors.length && dirty) save(update);
      }}
    >
      {(mockMode || sourceIsMock) && (
        <div className="banner" role="note">
          <span className="banner-icon" aria-hidden>
            !
          </span>
          <p>
            {mockMode
              ? 'Mock mode: these are fixture values and saving changes nothing.'
              : 'Showing fixture values because the settings API isn’t live yet. Saving still calls n8n.'}
          </p>
        </div>
      )}

      <section className="card" aria-labelledby="auto-h">
        <div className="card-head">
          <h2 id="auto-h">Automation</h2>
          <span className={`chip ${status === 'active' ? 'chip-filled' : 'chip-queued'}`}>
            <span className="dot" aria-hidden />
            {status === 'active' ? 'Active' : 'Paused'}
          </span>
        </div>
        <p className="tile-note" style={{ margin: '0 0 14px' }}>
          {status === 'active'
            ? 'Every Sunday at 8:00 pm the audit invests what you didn’t spend.'
            : 'Paused: Sunday audits are recorded as skipped and nothing is invested.'}
        </p>
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => save({ status: status === 'active' ? 'paused' : 'active' })}
          >
            {status === 'active' ? 'Pause automation' : 'Resume automation'}
          </button>
          <a className="btn" href={saved.onboarding_url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
            Retake the investor quiz ↗
          </a>
        </div>
      </section>

      <section className="card" aria-labelledby="budgets-h">
        <div className="card-head">
          <h2 id="budgets-h">Weekly budgets</h2>
          <span className="hint">{cad(weeklyTotal)} a week · untick to switch a category off</span>
        </div>
        {draft.budgets.map((b, i) => (
          <div className="form-row" key={b.category_key}>
            <label htmlFor={`amt-${b.category_key}`} data-off={!b.active}>
              {b.label}
            </label>
            <div className="money-input">
              <span>$</span>
              <input
                id={`amt-${b.category_key}`}
                className="input"
                inputMode="decimal"
                value={b.amount}
                aria-invalid={!(num(b.amount) >= 0)}
                onChange={(e) => {
                  const budgets = [...draft.budgets];
                  budgets[i] = { ...b, amount: e.target.value };
                  setDraft({ ...draft, budgets });
                }}
              />
            </div>
            <label className="check" style={{ justifySelf: 'center' }}>
              <input
                type="checkbox"
                checked={b.active}
                aria-label={`${b.label} active`}
                onChange={(e) => {
                  const budgets = [...draft.budgets];
                  budgets[i] = { ...b, active: e.target.checked };
                  setDraft({ ...draft, budgets });
                }}
              />
            </label>
          </div>
        ))}
      </section>

      <section className="card" aria-labelledby="cushion-h">
        <div className="card-head">
          <h2 id="cushion-h">Cushion</h2>
          <span className="hint">Cash kept back before anything is invested</span>
        </div>
        <div className="grid-3">
          <div className="field">
            <label htmlFor="target">Target</label>
            <div className="money-input">
              <span>$</span>
              <input
                id="target"
                className="input"
                inputMode="decimal"
                value={draft.bufferTarget}
                aria-invalid={!(num(draft.bufferTarget) >= 0)}
                onChange={(e) => setDraft({ ...draft, bufferTarget: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="rate">Share of leftover that fills it</label>
            <div className="money-input pct">
              <input
                id="rate"
                className="input"
                inputMode="decimal"
                value={draft.cushionPct}
                aria-invalid={!(num(draft.cushionPct) >= 0 && num(draft.cushionPct) <= 100)}
                onChange={(e) => setDraft({ ...draft, cushionPct: e.target.value })}
              />
              <span>%</span>
            </div>
          </div>
          <div className="field">
            <span className="label">Overspending</span>
            <label className="check">
              <input
                type="checkbox"
                aria-label="Overspending comes out of the cushion"
                checked={draft.absorb}
                onChange={(e) => setDraft({ ...draft, absorb: e.target.checked })}
              />
              <span>Comes out of the cushion</span>
            </label>
          </div>
        </div>
        <p className="tile-note" style={{ marginTop: 14 }}>
          Limits: nothing is invested in a week under {cad(saved.min_invest_cad)} (it carries to next week), and at most{' '}
          {cad(saved.max_weekly_invest_cad, { decimals: 0 })} a week.
        </p>
      </section>

      <div className="save-bar">
        <button type="submit" className="btn btn-primary" disabled={busy || !dirty || errors.length > 0} aria-busy={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="btn" disabled={busy || !dirty} onClick={() => setDraft(draftFrom(saved))}>
          Undo
        </button>
        <span role="status" aria-live="polite" className="small">
          {errors.length > 0 ? (
            <span className="bad-ink">{errors[0]}</span>
          ) : msg ? (
            <span className={msg.tone === 'ok' ? 'good-ink' : msg.tone === 'warn' ? 'warn-ink' : 'bad-ink'}>{msg.text}</span>
          ) : dirty ? (
            <span className="muted">Unsaved changes</span>
          ) : null}
        </span>
      </div>
    </form>
  );
}
