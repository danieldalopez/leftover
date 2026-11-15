'use client';
import { useState } from 'react';
import { cad, day, pct } from '@/lib/format';
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
          <strong className="num">{cad(p.value_cad)}</strong>
        </div>
      ))}
      <p className="tile-note">From {cad(contributed)}, with nothing more added.</p>
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
      <div className="row">
        <span className="small on-page" id="rate-label">
          Assumed yearly return
        </span>
        <div className="seg" role="group" aria-labelledby="rate-label">
          {rates.map((r) => (
            <button key={r} type="button" aria-pressed={r === rate} onClick={() => setRate(r)}>
              {pct(r, 0)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="life-h">
          <div className="card-head">
            <h2 id="life-h">Everything invested so far</h2>
            <span className="hint">Illustrative</span>
          </div>
          {data.lifetime.contributed_cad > 0 ? (
            <>
              <div className="tile-value">{cad(data.lifetime.contributed_cad)}</div>
              <p className="tile-note">
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
            <span className="hint">Illustrative</span>
          </div>
          {data.last_week ? (
            <>
              <div className="tile-value">{cad(data.last_week.invested_cad)}</div>
              <p className="tile-note">invested from the week of {day(data.last_week.audit_id.slice(-10))}</p>
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
          <span className="hint">Illustrative value in 30 years at {pct(rate, 0)}</span>
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
                    <div className="small muted">
                      Under budget {c.weeks_under} of {c.weeks_total} weeks · {cad(c.leftover_cad)} left over
                    </div>
                  </div>
                  <strong className="num">{fv !== undefined ? cad(fv) : '—'}</strong>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <p className="small on-page">
        {data.disclaimer} Value = amount × (1 + {pct(rate, 0)})<sup>years</sup>, compounded yearly. Leftover is before the
        cushion, so it can be more than what was invested.
      </p>
    </>
  );
}
