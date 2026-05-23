/**
 * VestingSparkline — small SVG sparkline of a stream's accrual curve.
 *
 * Ported from `Canton Streams/src/primitives.jsx`. Draws the accrual line +
 * gradient fill + a marker at current progress. Accepts the SDK `Stream`
 * shape and re-derives accrual values via `accrualAt` (Phase 1's
 * pure helper backed by the SDK's accrual formulas).
 *
 * Phase 1 — STR-111.
 */
import { useMemo } from 'react';
import type { Stream } from '@canton-streams/sdk/browser';
import { useNow } from './useNow.js';
import { shapeFromStream, accrualAt } from '../../lib/accrualAt.js';

export interface VestingSparklineProps {
  readonly stream: Stream;
  readonly width?: number;
  readonly height?: number;
  readonly points?: number;
  readonly showProgress?: boolean;
}

export function VestingSparkline({
  stream,
  width = 120,
  height = 32,
  points = 40,
  showProgress = true,
}: VestingSparklineProps) {
  const now = useNow(1000);
  const shape = useMemo(() => shapeFromStream(stream), [stream]);

  const data = useMemo(() => {
    const arr: number[] = [];
    const startMs = shape.startTime.getTime();
    const endMs = shape.endTime.getTime();
    const total = shape.total.toNumber();
    if (total <= 0) return arr;
    for (let i = 0; i <= points; i++) {
      const t = startMs + (endMs - startMs) * (i / points);
      arr.push(accrualAt(shape, t).toNumber() / total);
    }
    return arr;
  }, [shape, points]);

  if (data.length === 0) {
    return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} />;
  }

  const startMs = shape.startTime.getTime();
  const endMs = shape.endTime.getTime();
  const progress = Math.min(1, Math.max(0, (now - startMs) / (endMs - startMs)));

  const path = data
    .map((v, i) => {
      const x = (i / points) * width;
      const y = height - v * (height - 2) - 1;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const fillPath = `${path} L${width},${height} L0,${height} Z`;

  const cx = progress * width;
  const cyIdx = Math.min(points, Math.floor(progress * points));
  const cy = height - (data[cyIdx] ?? 0) * (height - 2) - 1;
  const gradId = `spark-fill-${stream.contractId}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2={height}>
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.25" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gradId})`} />
      <path
        d={path}
        stroke="var(--accent)"
        strokeWidth="1.4"
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {showProgress && stream.state.status === 'Active' && (
        <>
          <line
            x1={cx}
            y1="0"
            x2={cx}
            y2={height}
            stroke="var(--accent)"
            strokeWidth="0.5"
            opacity="0.5"
          />
          <circle cx={cx} cy={cy} r="2.5" fill="var(--accent)" />
          <circle cx={cx} cy={cy} r="5" fill="var(--accent)" opacity="0.25" />
        </>
      )}
    </svg>
  );
}
