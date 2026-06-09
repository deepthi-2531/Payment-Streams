/**
 * Skeleton — shimmer placeholder for in-flight query state.
 *
 * New code prefers the static API on `Skeleton`:
 *
 *   {streams.isPending && <Skeleton.Row count={3} height={56} />}
 *   {streams.isError   && <ErrorState error={streams.error} onRetry={streams.refetch} />}
 */
import type { CSSProperties, ReactNode } from 'react';

export interface SkeletonProps {
  readonly className?: string;
  readonly width?: string | number;
  readonly height?: string | number;
  /** Visual rounding. Plain Skeleton defaults to 'md' (6px); pass 'full' for chips. */
  readonly rounded?: 'sm' | 'md' | 'lg' | 'full';
  readonly children?: ReactNode;
  readonly style?: CSSProperties;
}

const ROUNDED: Record<NonNullable<SkeletonProps['rounded']>, number | string> = {
  sm: 4,
  md: 6,
  lg: 12,
  full: 999,
};

function Box({
  width = '100%',
  height = 16,
  rounded = 'md',
  className,
  children,
  style,
}: SkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={['live-stripe', className].filter(Boolean).join(' ')}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: ROUNDED[rounded],
        display: 'block',
        ...style,
      }}
    >
      {children ? (
        <span className="sr-only">Loading {children}</span>
      ) : (
        <span className="sr-only">Loading…</span>
      )}
    </div>
  );
}

export interface SkeletonRowProps {
  readonly count: number;
  readonly height?: number;
  readonly gap?: number;
}

function Row({ count, height = 56, gap = 8 }: SkeletonRowProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: count }, (_, i) => (
        <Box key={i} height={height} />
      ))}
    </div>
  );
}

function Card({ minHeight = 120 }: { readonly minHeight?: number }) {
  return (
    <div
      className="card"
      style={{
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minHeight,
      }}
      aria-busy="true"
    >
      <Box height={10} width={80} />
      <Box height={28} width={140} />
      <div style={{ flex: 1 }} />
      <Box height={12} width="60%" />
    </div>
  );
}

export const Skeleton = Object.assign(Box, { Row, Card });

/** Convenience: skeleton text lines. Backwards-compat from the prior visual. */
export function SkeletonText({
  lines = 3,
  className,
}: {
  readonly lines?: number;
  readonly className?: string;
}) {
  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <Box
          key={i}
          height={12}
          width={i === lines - 1 ? '60%' : '100%'}
        />
      ))}
    </div>
  );
}

/** Convenience: skeleton card with title + lines. Backwards-compat. */
export function SkeletonCard({ className }: { readonly className?: string }) {
  return (
    <div
      className={['card', className].filter(Boolean).join(' ')}
      style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <Box height={20} width="40%" />
      <SkeletonText lines={3} />
    </div>
  );
}
