/**
 * FlowBar — vesting/withdrawal progress bar with optional shimmer.
 *
 * Ported from `Canton Streams/src/primitives.jsx`.
 *
 *   - `progress` is total vested (0..1)
 *   - `withdrawn` is the already-withdrawn portion (0..1; clamped to ≤ progress)
 *
 * The shimmer animation applies only when `status === 'Active'`; cancelled
 * streams render in danger color.
 *
 * Shared flow bar primitive.
 */
import type { CSSProperties } from 'react';
import type { StreamStatus } from '@canton-streams/sdk/browser';

export interface FlowBarProps {
  readonly progress: number;
  readonly withdrawn?: number;
  readonly height?: number;
  readonly status?: StreamStatus | string;
}

export function FlowBar({
  progress,
  withdrawn = 0,
  height = 8,
  status = 'Active',
}: FlowBarProps) {
  const p = Math.max(0, Math.min(1, progress));
  const w = Math.max(0, Math.min(p, withdrawn));
  const active = status === 'Active';

  const containerStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    height,
    background: 'var(--line)',
    borderRadius: 999,
    overflow: 'hidden',
  };

  const fillStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: `${p * 100}%`,
    background:
      status === 'Cancelled'
        ? 'linear-gradient(90deg, color-mix(in oklab, var(--danger) 50%, black), var(--danger))'
        : 'linear-gradient(90deg, var(--accent-dim), var(--accent))',
    borderRadius: 999,
    transition: 'width 600ms cubic-bezier(0.4,0,0.2,1)',
  };

  const shimmerStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    background:
      'linear-gradient(90deg, transparent 30%, color-mix(in oklab, var(--accent-2) 80%, white) 50%, transparent 70%)',
    backgroundSize: '50% 100%',
    backgroundRepeat: 'no-repeat',
    animation: 'shimmer 2.4s linear infinite',
    mixBlendMode: 'screen',
    opacity: 0.7,
  };

  const withdrawnStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '100%',
    width: `${w * 100}%`,
    background: 'color-mix(in oklab, var(--accent) 30%, black)',
    borderRadius: 999,
    opacity: 0.95,
  };

  return (
    <div style={containerStyle}>
      <div style={fillStyle}>{active && <div style={shimmerStyle} />}</div>
      <div style={withdrawnStyle} />
    </div>
  );
}
