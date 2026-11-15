'use client';
// Small dependency-free column chart (dataviz rules: one axis, <=24px bars with 4px rounded data
// ends, 2px gaps, hairline grid, legend + hover tooltip, table view lives next to it on the page).
import { useEffect, useRef, useState } from 'react';

export interface Series {
  key: string;
  label: string;
  color: string; // CSS color or var()
}

export interface Group {
  key: string;
  label: string;
  title: string; // tooltip heading
  values: Record<string, number>;
  extra?: { label: string; value: string }[]; // extra tooltip rows (no swatch)
}

interface Props {
  series: Series[];
  groups: Group[];
  /** 'diverging': series[0] grows up from the baseline, series[1] grows down (both given as positive numbers). */
  mode?: 'grouped' | 'diverging';
  height?: number;
  format: (n: number) => string;
  tickFormat?: (n: number) => string;
  ariaLabel: string;
}

function niceStep(max: number, ticks = 4): number {
  if (max <= 0) return 1;
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

/** Column path: square at the baseline, 4px rounded at the data end. */
function colPath(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const r = Math.min(4, w / 2, h);
  if (y1 < y0) {
    // grows up
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  // grows down
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

export default function ColumnChart({ series, groups, mode = 'grouped', height = 240, format, tickFormat, ariaLabel }: Props) {
  const tick = tickFormat ?? format;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  const m = { top: 18, right: 8, bottom: 30, left: 48 };
  const plotW = Math.max(0, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;

  const up = mode === 'diverging' ? [series[0]] : series;
  const down = mode === 'diverging' ? [series[1]] : [];
  const maxUp = Math.max(0, ...groups.flatMap((g) => up.map((s) => g.values[s.key] ?? 0)));
  const maxDown = Math.max(0, ...groups.flatMap((g) => down.map((s) => g.values[s.key] ?? 0)));
  const step = niceStep(Math.max(maxUp, maxDown, 1), mode === 'diverging' ? 2 : 4);
  const topV = Math.max(step, Math.ceil(maxUp / step) * step);
  const botV = mode === 'diverging' ? Math.max(maxDown > 0 ? step : 0, Math.ceil(maxDown / step) * step) : 0;
  const y = (v: number) => m.top + ((topV - v) / (topV + botV)) * plotH;
  const y0 = y(0);

  const ticks: number[] = [];
  for (let v = -botV; v <= topV + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);

  const band = groups.length ? plotW / groups.length : 0;
  const nCols = mode === 'diverging' ? 1 : series.length;
  const gap = 2;
  const barW = Math.max(4, Math.min(24, (band * 0.6 - gap * (nCols - 1)) / nCols));
  const groupW = barW * nCols + gap * (nCols - 1);

  const hovered = hover !== null ? groups[hover] : null;
  const tipX = hover !== null ? m.left + band * hover + band / 2 : 0;
  const tipTop =
    hovered !== null
      ? Math.min(...up.map((s) => y(hovered.values[s.key] ?? 0)), y0) - 2
      : 0;

  return (
    <div className="chart" ref={ref} style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'base-line' : 'grid-line'} x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} />
              <text className="axis-label" x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {tick(Math.abs(t))}
              </text>
            </g>
          ))}
          {groups.map((g, i) => {
            const gx = m.left + band * i + (band - groupW) / 2;
            return (
              <g key={g.key}>
                {hover === i && (
                  <rect x={m.left + band * i + 2} y={m.top} width={band - 4} height={plotH} fill="var(--surface-2)" rx={6} />
                )}
                {up.map((s, si) => {
                  const v = g.values[s.key] ?? 0;
                  return <path key={s.key} d={colPath(gx + si * (barW + gap), barW, y0, y(v))} fill={s.color} />;
                })}
                {down.map((s) => {
                  const v = g.values[s.key] ?? 0;
                  return <path key={s.key} d={colPath(gx, barW, y0, y(-v))} fill={s.color} />;
                })}
                <text className="axis-label" x={m.left + band * i + band / 2} y={height - 10} textAnchor="middle">
                  {g.label}
                </text>
                {/* hit target: the whole band, bigger than the marks; focusable for keyboard users */}
                <rect
                  x={m.left + band * i}
                  y={m.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${g.title}: ${series.map((s) => `${s.label} ${format(g.values[s.key] ?? 0)}`).join(', ')}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  style={{ outline: 'none' }}
                />
              </g>
            );
          })}
          {/* re-draw the baseline over the bars */}
          <line className="base-line" x1={m.left} x2={width - m.right} y1={y0} y2={y0} />
        </svg>
      )}
      {hovered && (
        <div className="tooltip" style={{ left: Math.min(Math.max(tipX, 90), width - 90), top: Math.max(tipTop, 60) }}>
          <div className="t-title">{hovered.title}</div>
          {series.map((s) => (
            <div className="t-row" key={s.key}>
              <span>
                <span className="swatch" style={{ background: s.color }} /> {s.label}
              </span>
              <strong>{format(hovered.values[s.key] ?? 0)}</strong>
            </div>
          ))}
          {hovered.extra?.map((e) => (
            <div className="t-row" key={e.label}>
              <span>{e.label}</span>
              <strong>{e.value}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
