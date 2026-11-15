'use client';
import { useState } from 'react';
import { cad, day, rateLabel } from '@/lib/format';
import type { FvPoint, Projection } from '@/lib/types';

function byRate<T>(rec: Record<string, T> | undefined, r: number): T | undefined {
  if (!rec) return undefined;
  return rec[String(r)] ?? rec[r.toFixed(2)];
}

function FvRows({ points, contributed, scaleMax }: { points: FvPoint[]; contributed: number; scaleMax: number }) {
  return (
    <div>
      {points.map((p) => (
        <div className="fv-row" key={p.years}>
          <span className="small ink-2">{p.years} years</span>
          <div className="fv-track" aria-hidden>
            <div className="fv-bar" style={{ width: `${scaleMax > 0 ? Math.max(2, (p.value_cad / scaleMax) * 100) : 0}%` }} />
          </div>
          <span className="num" style={{ fontWeight: 620 }}>
            {cad(p.value_cad)}
          </span>
        </div>
      ))}
      <p className="small muted" style={{ marginTop: 6 }}>
        From {cad(contributed)} put in. Assumes nothing more is added.
      </p>
    </div>
  );
}

export default function CompoundingView({ data }: { data: Projection }) {
  const rates = data.rates.length ? data.rates : [0.04, 0.06, 0.08];
  const [rate, setRate] = useState<number>(rates.includes(data.selected_rate) ? data.selected_rate : rates[Math.floor(rates.length / 2)]);
  const maxRate = Math.max(...rates);
  const lifetimePts = byRate(data.lifetime.by_rate, rate) ?? [];
  const lifetimeScale = Math.max(...(byRate(data.lifetime.by_rate, maxRate) ?? []).map((p) => p.value_cad), 0);
  const lastPts = data.last_week ? byRate(data.last_week.by_rate, rate) ?? [] : [];
  const lastScale = data.last_week ? Math.max(...(byRate(data.last_week.by_rate, maxRate) ?? []).map((p) => p.value_cad), 0) : 0;

  return (
    <>
      <div className="banner banner-info" role="note">
        <span className="banner-icon" aria-hidden>
          i
        </span>
        <p>
          {/^illustrative/i.test(data.disclaimer) ? '' : 'Illustrative. '}
          {data.disclaimer}
        </p>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="small ink-2" style={{ fontWeight: 600 }} id="rate-label">
          Assumed yearly return
        </span>
        <div className="seg" role="group" aria-labelledby="rate-label">
          {rates.map((r) => (
            <button key={r} type="button" aria-pressed={r === rate} onClick={() => setRate(r)}>
              {rateLabel(r)}
            </button>
          ))}
        </div>
        <span className="illustrative">Illustrative</span>
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="life-h">
          <div className="card-head">
            <h2 id="life-h">Everything invested so far</h2>
            <span className="illustrative">Illustrative</span>
          </div>
          {data.lifetime.contributed_cad > 0 ? (
            <>
              <div className="tile-value">{cad(data.lifetime.contributed_cad)}</div>
              <p className="small ink-2" style={{ marginBottom: 10 }}>
                over {data.lifetime.weeks_invested} {data.lifetime.weeks_invested === 1 ? 'week' : 'weeks'} · about{' '}
                {cad(data.lifetime.weekly_average_cad)} a week
              </p>
              <FvRows points={lifetimePts} contributed={data.lifetime.contributed_cad} scaleMax={lifetimeScale} />
            </>
          ) : (
            <p className="muted">Nothing invested yet. After the first invested audit, its growth shows up here.</p>
          )}
        </section>

        <section className="card" aria-labelledby="last-h">
          <div className="card-head">
            <h2 id="last-h">Last week&apos;s leftover</h2>
            <span className="illustrative">Illustrative</span>
          </div>
          {data.last_week ? (
            <>
              <div className="tile-value">{cad(data.last_week.invested_cad)}</div>
              <p className="small ink-2" style={{ marginBottom: 10 }}>
                invested from the week of {day(data.last_week.audit_id.slice(-10))}
              </p>
              <FvRows points={lastPts} contributed={data.last_week.invested_cad} scaleMax={lastScale} />
            </>
          ) : (
            <p className="muted">No invested week yet.</p>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="choices-h">
        <div className="card-head">
          <h2 id="choices-h">Your choices</h2>
          <span className="hint">
            Leftover each category created, and what it could be in 30 years at {rateLabel(rate)}
          </span>
        </div>
        {data.your_choices.length === 0 ? (
          <p className="muted">No audited weeks yet.</p>
        ) : (
          <div>
            {data.your_choices.map((c) => {
              const fv = byRate(c.fv_30y_cad, rate);
              return (
                <div className="choice" key={c.category_key}>
                  <div>
                    <strong>{c.label}</strong>
                    <div className="small ink-2">
                      Under budget {c.weeks_under} of {c.weeks_total} weeks · {cad(c.leftover_cad)} left over
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="num" style={{ fontWeight: 650 }}>
                      {fv !== undefined ? cad(fv) : '—'}
                    </div>
                    <div className="small muted">illustrative 30-year value</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="small muted" style={{ marginTop: 10 }}>
          Value = amount × (1 + {rateLabel(rate)})<sup>years</sup>, compounded yearly. Real returns vary year to year and can be
          negative. Leftover is before the cushion, so it can be more than what was invested.
        </p>
      </section>
    </>
  );
}
