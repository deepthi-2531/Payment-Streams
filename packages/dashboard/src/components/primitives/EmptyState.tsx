/**
 * EmptyState — centered icon + title + body for empty lists / no-results panels.
 *
 * Ported from `Canton Streams/src/primitives.jsx`.
 *
 * Phase 1 — STR-111. Phase 3 (STR-114) reuses this aesthetic for the global
 * `Skeleton` / `LoadingState` / `ErrorState` primitives.
 */
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly body?: ReactNode;
  readonly cta?: ReactNode;
}

export function EmptyState({ icon, title, body, cta }: EmptyStateProps) {
  return (
    <div
      style={{
        padding: '48px 24px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: 'var(--card-2)',
          border: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--fg-3)',
        }}
      >
        {icon}
      </div>
      <div>
        <div style={{ fontWeight: 500, color: 'var(--fg-2)' }}>{title}</div>
        {body && (
          <div style={{ fontSize: 12, color: 'var(--fg-4)', marginTop: 4 }}>{body}</div>
        )}
      </div>
      {cta}
    </div>
  );
}
