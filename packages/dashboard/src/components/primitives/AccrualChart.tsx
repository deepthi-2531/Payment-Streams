/**
 * AccrualChart — full-size vesting curve chart for StreamDetail page.
 *
 * Ported from `Canton Streams/src/primitives.jsx`. Renders the accrual
 * line + gradient fill + gridlines + withdrawn baseline + animated
 * current-position marker (only on Active streams).
 *
 * Phase 1 — STR-111. Replaces the placeholder `streams/AccrualChart.tsx`
 * (which re-exports this primitive from Phase 1 onwards).
 */
import { useMemo } from 'react';
import type { Stream } from '@canton-streams/sdk/browser';
import Decimal from 'decimal.js';
import { useNow } from './useNow.js';
import { shapeFromStream, accrualAt } from '../../lib/accrualAt.js';

export interface AccrualChartProps {
  readonly stream: Stream;
  readonly height?: number;
  readonly points?: number;
  readonly liveTick?: boolean;
}

function fmtDate(t: Date | number, year?: '2-digit' | 'numeric'): string {
  const d = typeof t === 'number' ? new Date(t) : t;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(year ? { year } : {}),
  });
}

function fmtAmount(n: Decimal, decimals = 2): string {
  return n.toFixed(decimals, Decimal.ROUND_HALF_UP);
}

export function AccrualChart({
  stream,
  height = 220,
  points = 80,
  liveTick = true,
}: AccrualChartProps) {
  const now = useNow(liveTick ? 100 : 60_000);
  const shape = useMemo(() => shapeFromStream(stream), [stream]);

  const total = shape.total.toNumber();
  const startMs = shape.startTime.getTime();
  const endMs = shape.endTime.getTime();
  const width = 800;

  const data = useMemo(() => {
    const arr: Array<{ t: number; accrued: number }> = [];
    if (total <= 0) return arr;
    for (let i = 0; i <= points; i++) {
      const t = startMs + (endMs - startMs) * (i / points);
      arr.push({ t, accrued: accrualAt(shape, t).toNumber() });
    }
    return arr;
  }, [shape, total, startMs, endMs, points]);

  if (total <= 0 || data.length === 0) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-elev)',
          borderRadius: 'var(--r-md)',
          color: 'var(--fg-4)',
          fontSize: 12,
        }}
      >
        Awaiting stream data
      </div>
    );
  }

  const xAt = (t: number) => ((t - startMs) / (endMs - startMs)) * width;
  const yAt = (v: number) => height - (v / total) * (height - 40) - 20;

  const path = data
    .map(
      (d, i) =>
        `${i === 0 ? 'M' : 'L'}${xAt(d.t).toFixed(2)},${yAt(d.accrued).toFixed(2)}`,
    )
    .join(' ');
  const fillPath = `${path} L${width},${height} L0,${height} Z`;

  const progress = Math.min(1, Math.max(0, (now - startMs) / (endMs - startMs)));
  const accruedNow = accrualAt(shape, now).toNumber();
  const cx = progress * width;
  const cy = yAt(accruedNow);

  const withdrawnNum = (shape.withdrawn ?? new Decimal(0)).toNumber();
  const withdrawnY = yAt(withdrawnNum);

  const tickCount = 6;
  const xTicks = Array.from({ length: tickCount }, (_, i) => {
    const t = startMs + (endMs - startMs) * (i / (tickCount - 1));
    return { t, x: xAt(t) };
  });
  const gradId = `detail-fill-${stream.contractId}`;

  return (
    <div style={{ width: '100%', position: 'relative' }}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ display: 'block', overflow: 'visible' }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2={height}>
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* gridlines */}
        {[0.25, 0.5, 0.75, 1].map((v) => (
          <line
            key={v}
            x1="0"
            y1={yAt(total * v)}
            x2={width}
            y2={yAt(total * v)}
            stroke="var(--line)"
            strokeDasharray="2 3"
            strokeWidth="0.5"
          />
        ))}

        {/* withdrawn baseline */}
        {withdrawnNum > 0 && (
          <line
            x1="0"
            y1={withdrawnY}
            x2={width}
            y2={withdrawnY}
            stroke="var(--info)"
            strokeDasharray="3 3"
            strokeWidth="0.8"
            opacity="0.6"
          />
        )}

        {/* accrual area */}
        <path d={fillPath} fill={`url(#${gradId})`} />
        <path d={path} stroke="var(--accent)" strokeWidth="1.6" fill="none" />

        {/* current point */}
        {stream.state.status === 'Active' && (
          <>
            <line
              x1={cx}
              y1="0"
              x2={cx}
              y2={height}
              stroke="var(--accent)"
              strokeWidth="0.8"
              opacity="0.5"
            />
            <circle cx={cx} cy={cy} r="4" fill="var(--accent)" />
            <circle cx={cx} cy={cy} r="9" fill="var(--accent)" opacity="0.2">
              <animate
                attributeName="r"
                values="4;14;4"
                dur="2.4s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0.35;0;0.35"
                dur="2.4s"
                repeatCount="indefinite"
              />
            </circle>
          </>
        )}
      </svg>

      {/* X-axis labels */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: '6px 0',
        }}
      >
        {xTicks.map((tick, i) => (
          <span
            key={i}
            className="mono"
            style={{ fontSize: 10, color: 'var(--fg-4)' }}
          >
            {fmtDate(tick.t, '2-digit')}
          </span>
        ))}
      </div>

      {/* legend */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          marginTop: 6,
          fontSize: 11,
          color: 'var(--fg-3)',
        }}
      >
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span
            style={{
              width: 8,
              height: 8,
              background: 'var(--accent)',
              borderRadius: 2,
            }}
          />
          Accrued
        </span>
        {withdrawnNum > 0 && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span
              style={{
                width: 12,
                height: 1.5,
                borderTop: '1.5px dashed var(--info)',
              }}
            />
            Withdrawn:{' '}
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              {fmtAmount(shape.withdrawn ?? new Decimal(0))}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
