/**
 * ErrorState — display for TanStack queries in `isError` state.
 *
 * Rewritten for STR-116 Phase 5 using cc-streams design tokens
 * (var(--danger), .card surface, var(--font-mono)). Replaces the
 * earlier Tailwind rose-tinted version.
 */

import type { CSSProperties, ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

export interface ErrorStateProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly error?: unknown;
  readonly onRetry?: () => void;
  readonly retryLabel?: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const wrapperStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 14,
  padding: 18,
  background: 'var(--danger-soft)',
  border: '1px solid color-mix(in oklab, var(--danger) 30%, transparent)',
  borderRadius: 'var(--r-lg)',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--danger)',
};

const descStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 12.5,
  color: 'var(--fg-2)',
};

const messageStyle: CSSProperties = {
  marginTop: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  color: 'var(--fg-3)',
  background: 'var(--bg-elev)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-sm)',
  padding: '6px 10px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const retryBtnStyle: CSSProperties = {
  marginTop: 12,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  borderRadius: 'var(--r-md)',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--danger)',
  background: 'color-mix(in oklab, var(--danger) 18%, transparent)',
  border: '1px solid color-mix(in oklab, var(--danger) 30%, transparent)',
};

export function ErrorState({
  title = 'Something went wrong',
  description,
  error,
  onRetry,
  retryLabel = 'Retry',
  className,
  style,
}: ErrorStateProps) {
  const message = error instanceof Error ? error.message : error ? String(error) : undefined;

  return (
    <div role="alert" className={className} style={{ ...wrapperStyle, ...style }}>
      <AlertTriangle
        size={20}
        style={{ flexShrink: 0, color: 'var(--danger)', marginTop: 2 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3 style={titleStyle}>{title}</h3>
        {description && <p style={descStyle}>{description}</p>}
        {message && <pre style={messageStyle}>{message}</pre>}
        {onRetry && (
          <button type="button" onClick={onRetry} style={retryBtnStyle}>
            <RotateCw size={11} />
            {retryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
