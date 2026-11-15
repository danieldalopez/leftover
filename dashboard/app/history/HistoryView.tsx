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
        <p className="muted">
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

  const filter = (
    <select id="cat" className="input" aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)}>
      <option value={ALL}>All categories</option>
      {categories.map((c) => (
        <option key={c.key} value={c.key}>
          {c.label}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <section className="card grid-3" aria-label="Totals">
        <div>
          <div className="tile-label">Left over</div>
          <div className="tile-value">{cad(t.gross_surplus_cad)}</div>
          <div className="tile-note">Unspent budget, all weeks</div>
        </div>
        <div>
          <div className="tile-label">To cushion</div>
          <div className="tile-value">{cad(t.to_buffer_cad)}</div>
          <div className="tile-note">Kept as cash</div>
        </div>
        <div>
          <div className="tile-label">Invested</div>
          <div className="tile-value">{cad(t.invested_cad)}</div>
          <div className="tile-note">
            {t.weeks_invested} of {t.weeks_audited} weeks
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="chart-h">
        <div className="card-head">
          <h2 id="chart-h">{cat === ALL ? 'Weekly leftover' : `${catLabel}: under or over budget`}</h2>
          {filter}
        </div>
        {cat === ALL ? (
          <ColumnChart
            key="all"
            ariaLabel="Weekly left over, to cushion and invested, oldest week first"
            series={[
              { key: 'gross', label: 'Left over', color: 'var(--leftover)' },
              { key: 'buffer', label: 'To cushion', color: 'var(--cushion)' },
              { key: 'invested', label: 'Invested', color: 'var(--invested)' },
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
        <div className="legend">
          {(cat === ALL
            ? [
                ['Left over', 'var(--leftover)'],
                ['To cushion', 'var(--cushion)'],
                ['Invested', 'var(--invested)'],
              ]
            : [
                ['Under budget ↑', 'var(--under)'],
                ['Over budget ↓', 'var(--over)'],
              ]
          ).map(([label, color]) => (
            <span key={label}>
              <span className="swatch" style={{ background: color }} /> {label}
            </span>
          ))}
        </div>
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
                  <th className="num">To cushion</th>
                  <th className="num">Invested</th>
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
                    <td className="num">{cad(a.to_buffer_cad)}</td>
                    <td className="num">
                      {a.status === 'invested' ? (
                        <strong>{cad(a.investable_cad)}</strong>
                      ) : a.status === 'computed' && a.investable_cad > 0 ? (
                        <span className="muted" title="Computed by the audit but not sent to Alpaca">
                          {cad(a.investable_cad)} ready
                        </span>
                      ) : (
                        '—'
                      )}
                      {a.pending_carry_after_cad > 0 && (
                        <div className="small muted">{cad(a.pending_carry_after_cad)} carried</div>
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
                  <td className="num">{cad(t.to_buffer_cad)}</td>
                  <td className="num">{cad(t.invested_cad)}</td>
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
          <h2 id="streaks-h">Streaks</h2>
          <span className="hint">Weeks at or under budget, oldest first</span>
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
                <div key={s.category_key}>
                  <div>{s.label}</div>
                  <div className="pips" aria-label={`${s.weeks_under} of ${s.weeks_total} weeks under budget, oldest first`}>
                    {pips.map((p) => (
                      <span key={p.key} data-under={p.under} />
                    ))}
                    <em className="small">{s.current_streak > 0 ? `${s.current_streak}-week streak` : 'over last week'}</em>
                  </div>
                </div>
              );
            })}
        </div>
      </section>
    </>
  );
}
