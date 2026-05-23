/**
 * MonoCounter — smoothly-animated ticking number with tabular figures.
 *
 * Ported from `Canton Streams/src/primitives.jsx`. Uses a requestAnimationFrame
 * loop to approach `value` exponentially (35% of remaining diff per frame),
 * which gives a satisfying live-counter feel without jarring jumps when
 * the underlying value updates.
 *
 * Phase 1 — STR-111.
 *
 * Numeric formatting delegates to `formatAmount` (a typed port of the mock's
 * `fmtAmount`) so all currency display stays consistent.
 */
import { useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';

export interface MonoCounterProps {
  readonly value: number;
  readonly decimals?: number;
  readonly asset?: string;
  readonly size?: number;
  readonly weight?: number;
  readonly prefix?: string;
  readonly accent?: boolean;
}

/**
 * Locale-aware decimal formatter. Mirrors the mock's `fmtAmount(n, asset, opts)`
 * without the asset registry lookup (assets aren't typed in this primitive's
 * scope yet — Phase 5 will fold in real asset metadata).
 */
function formatAmount(n: number, decimals: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '0.00';
  return new Decimal(n).toFixed(decimals, Decimal.ROUND_HALF_UP);
}

export function MonoCounter({
  value,
  decimals = 2,
  asset,
  size = 32,
  weight = 500,
  prefix,
  accent = false,
}: MonoCounterProps) {
  const [display, setDisplay] = useState(value);
  const ref = useRef(value);

  useEffect(() => {
    let raf: number | null = null;
    const animate = () => {
      const diff = value - ref.current;
      if (Math.abs(diff) < 0.0001) {
        ref.current = value;
        setDisplay(value);
        return;
      }
      ref.current += diff * 0.35;
      setDisplay(ref.current);
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [value]);

  // `asset` reserved for future per-asset decimal precision (Phase 5).
  void asset;
  const formatted = formatAmount(display, decimals);

  return (
    <span
      className="mono"
      style={{
        fontSize: size,
        fontWeight: weight,
        color: accent ? 'var(--accent)' : 'var(--fg)',
        letterSpacing: '-0.025em',
        fontVariantNumeric: 'tabular-nums',
        display: 'inline-flex',
        alignItems: 'baseline',
        lineHeight: 1,
      }}
    >
      {prefix && (
        <span style={{ color: 'var(--fg-4)', marginRight: 2, fontWeight: 400 }}>
          {prefix}
        </span>
      )}
      {formatted}
    </span>
  );
}
