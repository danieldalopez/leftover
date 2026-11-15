import type { Metadata } from 'next';
import Link from 'next/link';
import SourceBadge from '@/components/SourceBadge';
import { getSummary } from '@/lib/n8n';
import { cad, day, pct, weekRange, weekdayTime, STATUS_LABELS } from '@/lib/format';
import type { SummaryLine } from '@/lib/types';

export const metadata: Metadata = { title: 'This week' };

function CategoryRow({ line }: { line: SummaryLine }) {
  const planned = line.planned_cad;
  const filled = planned > 0 ? Math.min(line.actual_cad / planned, 1) : 0;
  const pendingStart = planned > 0 ? Math.min((line.actual_cad - line.pending_cad) / planned, 1) : 0;
  const status = line.state === 'over' ? `▲ ${cad(line.over_cad)} over` : `${cad(line.remaining_cad)} left`;
  return (
    <div>
      <div className="cat-row-top">
        <span className="cat-name">{line.label}</span>
        <span className="cat-amounts">
          {cad(line.actual_cad)} of {cad(planned, { decimals: 0 })} ·{' '}
          <span className="state-tag" data-state={line.state}>
            {status}
          </span>
        </span>
      </div>
      <div
        className="bar"
        data-state={line.state}
        role="meter"
        aria-label={`${line.label}: ${cad(line.actual_cad)} of ${cad(planned)} spent`}
        aria-valuemin={0}
        aria-valuemax={planned}
        aria-valuenow={Math.min(line.actual_cad, planned)}
      >
        <span className="bar-fill" style={{ width: `${filled * 100}%` }} />
        {line.pending_cad > 0 && (
          <span
            className="bar-pending"
            title={`${cad(line.pending_cad)} pending`}
            style={{ left: `${pendingStart * 100}%`, width: `${(filled - pendingStart) * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

export default async function ThisWeekPage() {
  const { data: s, source } = await getSummary();
  const t = s.totals;
  const cushionFull = s.buffer.target_cad > 0 ? Math.min(s.buffer.balance_cad / s.buffer.target_cad, 1) : 1;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>This week</h1>
          <p className="sub">
            {weekRange(s.week.week_start, s.week.week_end)} · {s.week.days_left} {s.week.days_left === 1 ? 'day' : 'days'} left
          </p>
        </div>
        <SourceBadge source={source} />
      </div>

      {s.status === 'paused' && (
        <div className="banner" role="status">
          <span className="banner-icon" aria-hidden>
            ‖
          </span>
          <p>
            Automation is <strong>paused</strong>: Sunday&apos;s audit will be recorded as skipped and nothing will be invested.{' '}
            <Link href="/settings">Resume in Settings</Link>.
          </p>
        </div>
      )}

      <section className="card hero" aria-label="This week at a glance">
        <div>
          <div className="tile-label">Projected leftover</div>
          <div className="tile-value big">{cad(t.projected_leftover_cad)}</div>
          <div className="tile-note">If this pace holds</div>
        </div>
        <div>
          <div className="tile-label">Spent</div>
          <div className="tile-value">
            {cad(t.actual_cad)} <small>of {cad(t.planned_cad, { decimals: 0 })}</small>
          </div>
          <div className="tile-note">{t.over_cad > 0 ? <span className="bad-ink">{cad(t.over_cad)} over budget</span> : `${cad(t.remaining_cad)} left`}</div>
        </div>
        <div>
          <div className="tile-label">Cushion</div>
          <div className="tile-value">
            {cad(s.buffer.balance_cad)} <small>of {cad(s.buffer.target_cad, { decimals: 0 })}</small>
          </div>
          <div
            className="meter"
            role="meter"
            aria-label="Cushion balance"
            aria-valuemin={0}
            aria-valuemax={s.buffer.target_cad}
            aria-valuenow={s.buffer.balance_cad}
          >
            <span style={{ width: `${cushionFull * 100}%` }} />
          </div>
        </div>
        <p className="hero-foot">
          {weekdayTime(s.week.next_audit_at)}: each category&apos;s unspent budget is added up
          {s.buffer.absorb_overspend ? ', overspending comes out of the cushion' : ''}, {pct(s.buffer.cushion_rate)} tops up the
          cushion, and the rest is invested (paper trading).
        </p>
      </section>

      <section className="card" aria-labelledby="cats">
        <div className="card-head">
          <h2 id="cats">By category</h2>
          <span className="hint">Spent of weekly budget</span>
        </div>
        <div className="cat-list">
          {s.lines.map((l) => (
            <CategoryRow key={l.category_key} line={l} />
          ))}
          {s.lines.length === 0 && <p className="muted">No active budgets. Add some in Settings.</p>}
        </div>
      </section>

      <section className="card" aria-labelledby="last">
        <div className="card-head">
          <h2 id="last">Last audit</h2>
          <Link href="/history" className="small">
            History →
          </Link>
        </div>
        {s.last_audit ? (
          <p>
            <strong>{cad(s.last_audit.investable_cad)}</strong> investable · week of {day(s.last_audit.week_start)} ·{' '}
            {s.last_audit.status === 'computed' ? 'ready to invest' : (STATUS_LABELS[s.last_audit.status] ?? s.last_audit.status).toLowerCase()}
          </p>
        ) : (
          <p className="muted">No audit yet. The first one runs {weekdayTime(s.week.next_audit_at)}.</p>
        )}
      </section>
    </div>
  );
}
