/**
 * LoadingState — centered spinner + label.
 *
 * Use when the entire view is awaiting first data (replaces inline
 * `animate-spin` borders scattered across pages). For card-level
 * placeholders, prefer `<Skeleton.Card>` instead — it gives the user a
 * sense of layout while data is in flight.
 *
 * Phase 3 — STR-114.
 */
import type { CSSProperties } from 'react';
import { Icons } from '../primitives/Icons.js';

export interface LoadingStateProps {
  readonly label?: string;
  readonly inline?: boolean;
  readonly size?: number;
}

export function LoadingState({
  label = 'Loading…',
  inline = false,
  size = 18,
}: LoadingStateProps) {
  const style: CSSProperties = inline
    ? {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        color: 'var(--fg-3)',
        fontSize: 12.5,
      }
    : {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        gap: 12,
        color: 'var(--fg-3)',
      };

  return (
    <div style={style} role="status" aria-live="polite">
      <Icons.Spinner size={size} />
      <span style={{ fontSize: inline ? 12.5 : 13 }}>{label}</span>
    </div>
  );
}
