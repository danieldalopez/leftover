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
  const status =
    line.state === 'over'
      ? `${cad(line.over_cad)} over`
      : line.state === 'near'
        ? `${cad(line.remaining_cad)} left · close to the limit`
        : `${cad(line.remaining_cad)} left`;
  return (
    <div>
      <div className="cat-row-top">
        <span className="cat-name">{line.label}</span>
        <span className="cat-amounts">
          <strong>{cad(line.actual_cad)}</strong> of {cad(planned)}
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
          <span className="bar-pending" style={{ left: `${pendingStart * 100}%`, width: `${(filled - pendingStart) * 100}%` }} />
        )}
      </div>
      <div className="cat-row-bottom">
        <span>
          <span className="state-tag" data-state={line.state}>
            {line.state === 'over' ? '▲ ' : line.state === 'near' ? '● ' : ''}
            {status}
          </span>
          {line.pending_cad > 0 && <span> · incl. {cad(line.pending_cad)} pending</span>}
        </span>
        <span>
          At this pace ~{cad(line.projected_actual_cad, { decimals: 0 })} →{' '}
          {line.projected_under_cad > 0 ? `${cad(line.projected_under_cad)} left over` : 'nothing left over'}
        </span>
      </div>
    </div>
  );
}

export default async function ThisWeekPage() {
  const { data: s, source } = await getSummary();
  const t = s.totals;
  const overCount = s.lines.filter((l) => l.state === 'over').length;
  const cushionFull = s.buffer.target_cad > 0 ? Math.min(s.buffer.balance_cad / s.buffer.target_cad, 1) : 1;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>This week</h1>
          <p className="sub">
            {weekRange(s.week.week_start, s.week.week_end)} · {s.week.days_left} {s.week.days_left === 1 ? 'day' : 'days'} left
            · audit {weekdayTime(s.week.next_audit_at)}
          </p>
        </div>
        <SourceBadge source={source} />
      </div>

      {s.status === 'paused' && (
        <div className="banner banner-warn" role="status">
          <span className="banner-icon" aria-hidden>
            ‖
          </span>
          <p>
            Automation is <strong>paused</strong>: Sunday&apos;s audit will be recorded as skipped and nothing will be invested.{' '}
            <Link href="/settings">Resume in Settings</Link>.
          </p>
        </div>
      )}

      <div className="grid-4">
        <div className="card">
          <div className="tile-label">Days left</div>
          <div className="tile-value">
            {s.week.days_left} <small>{s.week.days_left === 1 ? 'day' : 'days'}</small>
          </div>
          <div className="tile-note">Audit runs {weekdayTime(s.week.next_audit_at)}</div>
        </div>
        <div className="card">
          <div className="tile-label">Spent</div>
          <div className="tile-value">
            {cad(t.actual_cad)} <small>of {cad(t.planned_cad)}</small>
          </div>
          <div className="tile-note">
            {cad(t.remaining_cad)} left
            {overCount > 0 && (
              <span className="bad-ink">
                {' '}
                · {cad(t.over_cad)} over in {overCount} {overCount === 1 ? 'category' : 'categories'}
              </span>
            )}
          </div>
        </div>
        <div className="card">
          <div className="tile-label">Projected leftover</div>
          <div className="tile-value">{cad(t.projected_leftover_cad)}</div>
          <div className="tile-note">Estimate if this pace holds, before the cushion</div>
        </div>
        <div className="card">
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
          <div className="tile-note">
            {pct(s.buffer.cushion_rate)} of each leftover tops it up
            {s.buffer.absorb_overspend ? '; it absorbs overspending' : ''}
          </div>
        </div>
      </div>

      <section className="card" aria-labelledby="cats">
        <div className="card-head">
          <h2 id="cats">By category</h2>
          <span className="hint">Spent vs weekly budget · striped = pending</span>
        </div>
        <div className="cat-list">
          {s.lines.map((l) => (
            <CategoryRow key={l.category_key} line={l} />
          ))}
          {s.lines.length === 0 && <p className="muted">No active budgets. Add some in Settings.</p>}
        </div>
      </section>

      <div className="grid-2">
        <section className="card" aria-labelledby="last">
          <div className="card-head">
            <h2 id="last">Last audit</h2>
            <Link href="/history" className="small">
              History →
            </Link>
          </div>
          {s.last_audit ? (
            <>
              <div className="tile-value">{cad(s.last_audit.investable_cad)}</div>
              <p className="ink-2 small" style={{ marginTop: 4 }}>
                Week of {day(s.last_audit.week_start)} · {STATUS_LABELS[s.last_audit.status] ?? s.last_audit.status}
                {s.last_audit.status === 'computed' ? ' · not invested yet' : ''}
              </p>
              <p className="muted small" style={{ marginTop: 8 }}>
                {cad(s.lifetime.invested_cad)} invested over {s.lifetime.weeks_invested} of {s.lifetime.weeks_audited} audited
                weeks.
              </p>
            </>
          ) : (
            <p className="muted">No audit yet. The first one runs {weekdayTime(s.week.next_audit_at)}.</p>
          )}
        </section>
        <section className="card" aria-labelledby="how">
          <div className="card-head">
            <h2 id="how">What happens on Sunday</h2>
          </div>
          <ol className="small ink-2" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            <li>Each category&apos;s unspent budget is added up. Categories aren&apos;t netted against each other.</li>
            <li>
              {s.buffer.absorb_overspend ? 'Overspending comes out of your cushion first. Then ' : ''}
              {pct(s.buffer.cushion_rate)} of the leftover tops the cushion up until it reaches{' '}
              {cad(s.buffer.target_cad, { decimals: 0 })}.
            </li>
            <li>The rest is invested in your ETF mix (paper trading). Orders placed on a weekend fill at Monday&apos;s open.</li>
          </ol>
        </section>
      </div>
    </div>
  );
}
