/**
 * MonoCounter — smoothly-animated ticking number with tabular figures.
 *
 * Uses a requestAnimationFrame loop to approach `value` exponentially,
 * which gives a satisfying live-counter feel without jarring jumps when
 * the underlying value updates.
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
 * Locale-aware decimal formatter without relying on asset registry metadata.
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

  // `asset` is reserved for future per-asset decimal precision.
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
