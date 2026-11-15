'use client';
import { useMemo, useState } from 'react';
import ColumnChart, { type Group } from '@/components/ColumnChart';
import { cad, day, weekRange, STATUS_LABELS } from '@/lib/format';
import type { Audits } from '@/lib/types';

const ALL = 'all';
const tickCad = (n: number) => cad(n, { decimals: 0 });

export default function HistoryView({ data }: { data: Audits }) {
  const [cat, setCat] = useState<string>(ALL);
  const audits = data.audits; // newest first
  const oldestFirst = useMemo(() => [...audits].reverse(), [audits]);
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of data.streaks) seen.set(s.category_key, s.label);
    for (const a of audits) for (const l of a.lines) if (!seen.has(l.category_key)) seen.set(l.category_key, l.label);
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [audits, data.streaks]);
  const catLabel = categories.find((c) => c.key === cat)?.label ?? '';
  const t = data.totals;

  if (audits.length === 0) {
    return (
      <div className="card">
        <h2>No audits yet</h2>
        <p className="muted" style={{ marginTop: 6 }}>
          The first audit runs Sunday at 8:00 pm, or press <strong>Run audit now</strong> in the demo bar.
        </p>
      </div>
    );
  }

  const allGroups: Group[] = oldestFirst.map((a) => ({
    key: a.audit_id,
    label: day(a.week_start),
    title: `Week of ${weekRange(a.week_start, a.week_end)}`,
    values: { gross: a.gross_surplus_cad, buffer: a.to_buffer_cad, invested: a.status === 'invested' ? a.investable_cad : 0 },
    extra: [{ label: 'Overspent', value: cad(a.total_over_cad) }],
  }));

  const catGroups: Group[] = oldestFirst.map((a) => {
    const l = a.lines.find((x) => x.category_key === cat);
    return {
      key: a.audit_id,
      label: day(a.week_start),
      title: `${catLabel} · week of ${weekRange(a.week_start, a.week_end)}`,
      values: { under: l?.under_cad ?? 0, over: l?.over_cad ?? 0 },
      extra: l ? [{ label: 'Spent', value: `${cad(l.actual_cad)} of ${cad(l.planned_cad)}` }] : [],
    };
  });

  return (
    <>
      <div className="grid-4">
        <div className="card">
          <div className="tile-label">Left over (gross)</div>
          <div className="tile-value">{cad(t.gross_surplus_cad)}</div>
          <div className="tile-note">Unspent budget, all weeks</div>
        </div>
        <div className="card">
          <div className="tile-label">To cushion</div>
          <div className="tile-value">{cad(t.to_buffer_cad)}</div>
          <div className="tile-note">Kept as cash for overspending</div>
        </div>
        <div className="card">
          <div className="tile-label">Invested</div>
          <div className="tile-value">{cad(t.invested_cad)}</div>
          <div className="tile-note">Paper trades, CAD at the time</div>
        </div>
        <div className="card">
          <div className="tile-label">Weeks invested</div>
          <div className="tile-value">
            {t.weeks_invested} <small>of {t.weeks_audited}</small>
          </div>
          <div className="tile-note">Audited weeks</div>
        </div>
      </div>

      <div className="filter-row" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="cat" className="small ink-2" style={{ fontWeight: 600 }}>
          Category
        </label>
        <select id="cat" className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value={ALL}>All categories</option>
          {categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <section className="card" aria-labelledby="chart-h">
        <div className="card-head">
          <h2 id="chart-h">{cat === ALL ? 'Weekly leftover' : `${catLabel}: under or over budget`}</h2>
          {cat === ALL ? (
            <div className="legend">
              <span>
                <span className="swatch" style={{ background: 'var(--series-1)' }} /> Left over
              </span>
              <span>
                <span className="swatch" style={{ background: 'var(--series-2)' }} /> To cushion
              </span>
              <span>
                <span className="swatch" style={{ background: 'var(--series-3)' }} /> Invested
              </span>
            </div>
          ) : (
            <div className="legend">
              <span>
                <span className="swatch" style={{ background: 'var(--under)' }} /> Under budget ↑
              </span>
              <span>
                <span className="swatch" style={{ background: 'var(--over)' }} /> Over budget ↓
              </span>
            </div>
          )}
        </div>
        {cat === ALL ? (
          <ColumnChart
            key="all"
            ariaLabel="Weekly left over, to cushion and invested, oldest week first"
            series={[
              { key: 'gross', label: 'Left over', color: 'var(--series-1)' },
              { key: 'buffer', label: 'To cushion', color: 'var(--series-2)' },
              { key: 'invested', label: 'Invested', color: 'var(--series-3)' },
            ]}
            groups={allGroups}
            format={(n) => cad(n)}
            tickFormat={tickCad}
          />
        ) : (
          <ColumnChart
            key={cat}
            mode="diverging"
            ariaLabel={`${catLabel}: amount under or over budget per week, oldest first`}
            series={[
              { key: 'under', label: 'Under budget', color: 'var(--under)' },
              { key: 'over', label: 'Over budget', color: 'var(--over)' },
            ]}
            groups={catGroups}
            format={(n) => cad(n)}
            tickFormat={tickCad}
          />
        )}
      </section>

      <section className="card" aria-labelledby="table-h">
        <div className="card-head">
          <h2 id="table-h">{cat === ALL ? 'Weeks' : `${catLabel} by week`}</h2>
          <span className="hint">Newest first</span>
        </div>
        <div className="table-wrap">
          {cat === ALL ? (
            <table>
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Status</th>
                  <th className="num">Left over</th>
                  <th className="num">Overspent</th>
                  <th className="num">To cushion</th>
                  <th className="num">Invested</th>
                  <th className="num">Cushion after</th>
                  <th>Best category</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((a) => (
                  <tr key={a.audit_id}>
                    <td>{weekRange(a.week_start, a.week_end)}</td>
                    <td>
                      <span className={`chip${a.status === 'invested' ? ' chip-filled' : ''}`}>
                        <span className="dot" aria-hidden />
                        {STATUS_LABELS[a.status] ?? a.status}
                      </span>
                    </td>
                    <td className="num">{cad(a.gross_surplus_cad)}</td>
                    <td className="num">{a.total_over_cad > 0 ? cad(a.total_over_cad) : '—'}</td>
                    <td className="num">{cad(a.to_buffer_cad)}</td>
                    <td className="num">
                      {a.status === 'invested' ? (
                        <strong>{cad(a.investable_cad)}</strong>
                      ) : a.status === 'computed' && a.investable_cad > 0 ? (
                        <span className="muted" title="Computed by the audit but not sent to Alpaca (backfill, or invest step failed)">
                          {cad(a.investable_cad)} not invested
                        </span>
                      ) : (
                        '—'
                      )}
                      {a.pending_carry_after_cad > 0 && (
                        <div className="small muted">{cad(a.pending_carry_after_cad)} carried</div>
                      )}
                    </td>
                    <td className="num">{cad(a.buffer_after_cad)}</td>
                    <td>
                      {a.best_category ? (
                        <>
                          {a.best_category.label} <span className="muted">({cad(a.best_category.under_cad)} under)</span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td />
                  <td className="num">{cad(t.gross_surplus_cad)}</td>
                  <td className="num">{cad(audits.reduce((s, a) => s + a.total_over_cad, 0))}</td>
                  <td className="num">{cad(t.to_buffer_cad)}</td>
                  <td className="num">{cad(t.invested_cad)}</td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Week</th>
                  <th className="num">Budget</th>
                  <th className="num">Spent</th>
                  <th className="num">Under</th>
                  <th className="num">Over</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((a) => {
                  const l = a.lines.find((x) => x.category_key === cat);
                  return (
                    <tr key={a.audit_id}>
                      <td>{weekRange(a.week_start, a.week_end)}</td>
                      <td className="num">{l ? cad(l.planned_cad) : '—'}</td>
                      <td className="num">{l ? cad(l.actual_cad) : '—'}</td>
                      <td className="num good-ink">{l && l.under_cad > 0 ? cad(l.under_cad) : '—'}</td>
                      <td className="num bad-ink">{l && l.over_cad > 0 ? cad(l.over_cad) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="card" aria-labelledby="streaks-h">
        <div className="card-head">
          <h2 id="streaks-h">Best-category streaks</h2>
          <span className="hint">Weeks at or under budget</span>
        </div>
        <div className="streaks">
          {[...data.streaks]
            .sort((a, b) => b.current_streak - a.current_streak || b.weeks_under - a.weeks_under)
            .map((s) => {
              const pips = oldestFirst.map((a) => {
                const l = a.lines.find((x) => x.category_key === s.category_key);
                return { key: a.audit_id, under: l ? l.actual_cad <= l.planned_cad : false };
              });
              return (
                <div className="streak" key={s.category_key} data-selected={cat === s.category_key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong>{s.label}</strong>
                    <span className="small ink-2 num">
                      {s.weeks_under}/{s.weeks_total}
                    </span>
                  </div>
                  <div className="small muted">
                    {s.current_streak > 0
                      ? `${s.current_streak}-week streak${s.current_streak === s.weeks_total && s.weeks_total > 1 ? ' · every week' : ''}`
                      : 'Over budget last week'}
                  </div>
                  <div className="pips" aria-label={`${s.weeks_under} of ${s.weeks_total} weeks under budget, oldest first`}>
                    {pips.map((p) => (
                      <span key={p.key} data-under={p.under} />
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      </section>
    </>
  );
}
