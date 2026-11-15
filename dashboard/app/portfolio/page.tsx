import type { Metadata } from 'next';
import Link from 'next/link';
import SourceBadge from '@/components/SourceBadge';
import { getPortfolio } from '@/lib/n8n';
import { cad, dateTime, day, pct, qty, usd, weekdayName, SLEEVE_LABELS, SLEEVE_SLOT } from '@/lib/format';
import type { Order, Portfolio } from '@/lib/types';

export const metadata: Metadata = { title: 'Portfolio' };

/** spec §12: a queued order on a weekend is expected, not an error. */
function queuedLabel(p: Portfolio): string {
  if (p.market_open) return 'Queued · filling at market';
  return `Queued · fills at ${p.next_open ? `${weekdayName(p.next_open)}'s` : 'the next'} open`;
}

function marketLine(p: Portfolio): string {
  if (p.market_open === true) return 'market open';
  if (p.next_open) return `market closed, next open ${dateTime(p.next_open)} PT`;
  if (p.market_open === false) return 'market closed';
  return 'market hours unavailable (Alpaca not connected)';
}

function OrderChip({ o, p }: { o: Order; p: Portfolio }) {
  const map: Record<string, { cls: string; label: string }> = {
    queued: { cls: 'chip-queued', label: queuedLabel(p) },
    partially_filled: { cls: 'chip-queued', label: 'Partially filled' },
    filled: { cls: 'chip-filled', label: 'Filled' },
    rejected: { cls: 'chip-rejected', label: 'Rejected' },
    canceled: { cls: '', label: 'Canceled' },
    dry_run: { cls: '', label: 'Dry run · not sent' },
  };
  const c = map[o.status] ?? { cls: '', label: o.status };
  return (
    <span className={`chip ${c.cls}`} title={`Alpaca status: ${o.alpaca_status}`}>
      <span className="dot" aria-hidden />
      {c.label}
    </span>
  );
}

function OrderDetail({ o, p }: { o: Order; p: Portfolio }) {
  if (o.status === 'queued') {
    return (
      <span className="muted">
        {p.market_open ? 'Filling now' : `Waiting for ${p.next_open ? `${weekdayName(p.next_open)}'s` : 'the next'} open`}
      </span>
    );
  }
  if (o.status === 'filled' || o.status === 'partially_filled') {
    return (
      <span className="ink-2">
        {qty(o.filled_qty)} @ {usd(o.filled_avg_price)}
        {o.filled_at && <span className="muted small" style={{ display: 'block' }}>{dateTime(o.filled_at)}</span>}
      </span>
    );
  }
  if (o.status === 'dry_run') return <span className="muted">Not sent to Alpaca</span>;
  return <span className="muted">—</span>;
}

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<{ fixture?: string }> }) {
  const { fixture } = await searchParams;
  const { data: p, source } = await getPortfolio(fixture === 'queued' ? 'queued' : 'default');
  const t = p.totals;
  const queued = p.orders.filter((o) => o.status === 'queued');
  const queuedEst = queued.reduce((s, o) => s + (o.estimated_value_usd ?? o.notional_usd), 0);
  const queuedCad = queued.reduce((s, o) => s + o.notional_cad, 0);

  // group orders by audit (newest first, as returned)
  const groups: { audit_id: string; week_start: string; orders: Order[] }[] = [];
  for (const o of p.orders) {
    const g = groups.find((x) => x.audit_id === o.audit_id);
    if (g) g.orders.push(o);
    else groups.push({ audit_id: o.audit_id, week_start: o.week_start, orders: [o] });
  }

  // allocation by sleeve (market value)
  const bySleeve = new Map<string, number>();
  for (const pos of p.positions) bySleeve.set(pos.sleeve, (bySleeve.get(pos.sleeve) ?? 0) + pos.market_value_usd);
  const totalMv = [...bySleeve.values()].reduce((a, b) => a + b, 0);
  const sleeves = [...bySleeve.entries()].sort((a, b) => (SLEEVE_SLOT[a[0]] ?? 9) - (SLEEVE_SLOT[b[0]] ?? 9));
  const sleeveColor = (s: string) => `var(--series-${SLEEVE_SLOT[s] ?? 4})`;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Portfolio</h1>
          <p className="sub">
            Alpaca paper account · {marketLine(p)}
          </p>
        </div>
        <SourceBadge source={source} />
      </div>

      {source.kind === 'mock' && (
        <p className="small muted">
          Preview fixture:{' '}
          {fixture === 'queued' ? <Link href="/portfolio">weekday (all filled)</Link> : <strong>weekday (all filled)</strong>} ·{' '}
          {fixture === 'queued' ? <strong>Sunday night (orders queued)</strong> : <Link href="/portfolio?fixture=queued">Sunday night (orders queued)</Link>}
        </p>
      )}

      {queued.length > 0 && (
        <div className="banner banner-warn" role="status">
          <span className="banner-icon" aria-hidden>
            ⏱
          </span>
          <p>
            <strong>
              {queued.length} {queued.length === 1 ? 'order' : 'orders'} queued
            </strong>{' '}
            ({cad(queuedCad)}, est. {usd(queuedEst)}).{' '}
            {p.market_open
              ? 'The market is open, so they should fill shortly.'
              : `Orders placed outside market hours fill at the next open${p.next_open ? `, ${dateTime(p.next_open)} PT` : ''}. This is expected, not an error.`}
          </p>
        </div>
      )}

      <div className="grid-4">
        <div className="card">
          <div className="tile-label">Market value</div>
          <div className="tile-value">{usd(t.market_value_usd)}</div>
          <div className="tile-note">≈ {cad(t.market_value_cad)} CAD{t.queued_usd > 0 ? ' · excludes queued' : ''}</div>
        </div>
        <div className="card">
          <div className="tile-label">Total contributed</div>
          <div className="tile-value">{cad(t.contributed_cad)}</div>
          <div className="tile-note">From weekly leftovers (CAD)</div>
        </div>
        <div className="card">
          <div className="tile-label">Unrealized gain</div>
          <div className={`tile-value ${t.unrealized_pl_usd > 0 ? 'good-ink' : t.unrealized_pl_usd < 0 ? 'bad-ink' : ''}`}>
            {t.unrealized_pl_usd > 0 ? '▲ ' : t.unrealized_pl_usd < 0 ? '▼ ' : ''}
            {usd(t.unrealized_pl_usd, { signed: true })}
          </div>
          <div className="tile-note">
            {pct(t.unrealized_pl_pct, 2, true)} on {usd(t.cost_basis_usd)} cost basis
          </div>
        </div>
        <div className="card">
          <div className="tile-label">Queued</div>
          <div className="tile-value">{usd(t.queued_usd)}</div>
          <div className="tile-note">
            {typeof p.fx_rate_usdcad === 'number'
              ? `FX ${p.fx_rate_usdcad.toFixed(4)} CAD per USD${p.fx_source ? ` (${p.fx_source})` : ''}`
              : 'FX rate unavailable'}
          </div>
        </div>
      </div>

      <section className="card" aria-labelledby="pos-h">
        <div className="card-head">
          <h2 id="pos-h">Positions</h2>
          <span className="hint">As of {dateTime(p.as_of)}</span>
        </div>
        {p.positions.length === 0 ? (
          <p className="muted">No positions yet. The first orders fill after the first invested audit.</p>
        ) : (
          <>
            <div className="segbar" role="img" aria-label={`Allocation: ${sleeves.map(([s, v]) => `${SLEEVE_LABELS[s] ?? s} ${pct(v / totalMv, 0)}`).join(', ')}`}>
              {sleeves.map(([s, v]) => (
                <span key={s} style={{ width: `${(v / totalMv) * 100}%`, background: sleeveColor(s) }} title={`${SLEEVE_LABELS[s] ?? s}: ${pct(v / totalMv, 0)}`} />
              ))}
            </div>
            <div className="legend" style={{ marginBottom: 12 }}>
              {sleeves.map(([s, v]) => (
                <span key={s}>
                  <span className="swatch" style={{ background: sleeveColor(s) }} /> {SLEEVE_LABELS[s] ?? s}{' '}
                  <span className="muted">{pct(v / totalMv, 0)}</span>
                </span>
              ))}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Sleeve</th>
                    <th className="num">Shares</th>
                    <th className="num">Price</th>
                    <th className="num">Value (USD)</th>
                    <th className="num">Value (CAD)</th>
                    <th className="num">Contributed</th>
                    <th className="num">Gain</th>
                  </tr>
                </thead>
                <tbody>
                  {p.positions.map((pos) => (
                    <tr key={pos.symbol}>
                      <td>
                        <strong>{pos.symbol}</strong>
                      </td>
                      <td className="ink-2">{SLEEVE_LABELS[pos.sleeve] ?? pos.sleeve}</td>
                      <td className="num">{qty(pos.qty)}</td>
                      <td className="num">{usd(pos.current_price_usd)}</td>
                      <td className="num">{usd(pos.market_value_usd)}</td>
                      <td className="num">{cad(pos.market_value_cad)}</td>
                      <td className="num">{cad(pos.contributed_cad)}</td>
                      <td className={`num ${pos.unrealized_pl_usd >= 0 ? 'good-ink' : 'bad-ink'}`}>
                        {usd(pos.unrealized_pl_usd, { signed: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="orders-h">
        <div className="card-head">
          <h2 id="orders-h">Orders</h2>
          <span className="hint">One per sleeve per invested week · newest first</span>
        </div>
        {groups.length === 0 ? (
          <p className="muted">No orders yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="orders-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Status</th>
                  <th className="num">Amount (CAD)</th>
                  <th className="num">Amount (USD)</th>
                  <th>Fill</th>
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.audit_id}>
                  <tr className="group-row">
                    <td colSpan={5} style={{ background: 'var(--surface-2)', fontWeight: 600 }}>
                      Week of {day(g.week_start)}{' '}
                      <span className="muted" style={{ fontWeight: 500 }}>
                        · {cad(g.orders.reduce((s, o) => s + o.notional_cad, 0))} · submitted {dateTime(g.orders[0].submitted_at)}
                      </span>
                    </td>
                  </tr>
                  {g.orders.map((o) => (
                    <tr key={o.client_order_id}>
                      <td className="c-sym">
                        <strong>{o.symbol}</strong> <span className="muted small">{SLEEVE_LABELS[o.sleeve] ?? o.sleeve}</span>
                      </td>
                      <td className="c-status">
                        <OrderChip o={o} p={p} />
                        {(o.status === 'queued' || o.status === 'dry_run') && (
                          <span className="small ink-2 num" style={{ marginLeft: 8 }}>
                            est. {usd(o.estimated_value_usd ?? o.notional_usd)}
                          </span>
                        )}
                      </td>
                      <td className="num c-cad">{cad(o.notional_cad)}</td>
                      <td className="num c-usd">{usd(o.notional_usd)}</td>
                      <td className="c-fill">
                        <OrderDetail o={o} p={p} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
