/**
 * VestingPreview — sparkline preview for the create wizard.
 *
 * Used in the side panel while the user is configuring a stream that
 * doesn't exist yet. Takes raw inputs (total/start/end/vesting) and
 * renders the would-be accrual curve.
 *
 * Ported from `Canton Streams/src/primitives.jsx`.
 *
 * Shared vesting preview primitive.
 */
import { useMemo } from 'react';
import Decimal from 'decimal.js';
import type { VestingModeConfig } from '@canton-streams/sdk/browser';
import { accrualAt, type AccrualShape } from '../../lib/accrualAt.js';

export interface VestingPreviewProps {
  readonly start: Date | number | null;
  readonly end: Date | number | null;
  readonly total: Decimal | number | null;
  readonly vesting: VestingModeConfig;
  readonly height?: number;
}

export function VestingPreview({
  start,
  end,
  total,
  vesting,
  height = 200,
}: VestingPreviewProps) {
  const valid =
    total !== null &&
    start !== null &&
    end !== null &&
    new Date(start).getTime() < new Date(end).getTime() &&
    new Decimal(total).gt(0);

  const startMs = valid && start !== null ? new Date(start).getTime() : 0;
  const endMs = valid && end !== null ? new Date(end).getTime() : 0;
  const totalDec = useMemo(
    () => (total !== null ? new Decimal(total) : new Decimal(0)),
    [total],
  );

  const shape: AccrualShape | null = useMemo(() => {
    if (!valid) return null;
    return {
      total: totalDec,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      vesting,
      status: 'Active',
      withdrawn: new Decimal(0),
    };
  }, [valid, totalDec, startMs, endMs, vesting]);

  const data = useMemo(() => {
    if (!shape) return null;
    const points = 100;
    const arr: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= points; i++) {
      const t = startMs + (endMs - startMs) * (i / points);
      const v = accrualAt(shape, t).toNumber();
      arr.push({ x: i / points, y: v });
    }
    return arr;
  }, [shape, startMs, endMs]);

  if (!valid || !data) {
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
        Set total, start, and end to preview
      </div>
    );
  }

  const width = 600;
  const totalNum = totalDec.toNumber();
  const xAt = (x: number) => x * width;
  const yAt = (v: number) => height - (v / totalNum) * (height - 30) - 15;

  const path = data
    .map(
      (d, i) =>
        `${i === 0 ? 'M' : 'L'}${xAt(d.x).toFixed(2)},${yAt(d.y).toFixed(2)}`,
    )
    .join(' ');
  const fillPath = `${path} L${width},${height} L0,${height} Z`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="prev-fill" x1="0" y1="0" x2="0" y2={height}>
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((v) => (
        <line
          key={v}
          x1="0"
          y1={yAt(totalNum * v)}
          x2={width}
          y2={yAt(totalNum * v)}
          stroke="var(--line)"
          strokeDasharray="2 3"
          strokeWidth="0.5"
        />
      ))}
      <path d={fillPath} fill="url(#prev-fill)" />
      <path d={path} stroke="var(--accent)" strokeWidth="1.6" fill="none" />
    </svg>
  );
}
