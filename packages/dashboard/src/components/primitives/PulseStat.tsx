/**
 * PulseStat — card with uppercase label + ticking MonoCounter + optional sub-text.
 *
 * Ported from `Canton Streams/src/primitives.jsx`. The KPI tile used on
 * the dashboard hero (e.g. `Active streams`, `Cumulative streamed`).
 *
 * Phase 1 — STR-111.
 */
import type { ReactNode } from 'react';
import { MonoCounter } from './MonoCounter.js';

export interface PulseStatProps {
  readonly label: ReactNode;
  readonly value: number;
  readonly asset?: string;
  readonly sub?: ReactNode;
  readonly accent?: boolean;
}

export function PulseStat({
  label,
  value,
  asset,
  sub,
  accent = false,
}: PulseStatProps) {
  return (
    <div className="card" style={{ padding: 18 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--fg-4)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div>
        <MonoCounter value={value} asset={asset} accent={accent} size={28} weight={500} />
        {asset && (
          <span
            className="mono"
            style={{ marginLeft: 6, fontSize: 13, color: 'var(--fg-3)' }}
          >
            {asset}
          </span>
        )}
      </div>
      {sub && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 6 }}>{sub}</div>
      )}
    </div>
  );
}
