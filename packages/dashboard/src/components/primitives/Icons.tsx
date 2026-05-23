/**
 * Icons — lucide-style inline SVG icon set, stroke-width 1.5, sized via
 * `currentColor`. Ported from the mock at `Canton Streams/src/icons.jsx`.
 *
 * Phase 1 of the Canton Streams UI integration (STR-111).
 *
 * Usage:
 *   <Icons.Dashboard size={16} />
 *   <Icons.Stream size={24} />
 *
 * The `Logo` icon uses a gradient from `--accent-2` to `--accent` so it
 * always tracks the active accent token.
 */
import type { ReactNode, SVGProps } from 'react';

// `stroke` is a SVG attribute string in React's typings; we use it for the
// numeric stroke-width, so we Omit it and add `strokeWeight` here as a
// distinct name. Callers stay simple — pass `stroke={1.5}` and we
// translate to SVG's `strokeWidth`.
interface BaseProps extends Omit<SVGProps<SVGSVGElement>, 'size' | 'stroke'> {
  size?: number;
  stroke?: number;
}

function IconBase({
  children,
  size = 16,
  stroke = 1.5,
  ...rest
}: BaseProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export type IconProps = BaseProps;

export const Icons = {
  Dashboard: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </IconBase>
  ),
  Stream: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 7c3 0 3 4 6 4s3-4 6-4 3 4 6 4" />
      <path d="M3 13c3 0 3 4 6 4s3-4 6-4 3 4 6 4" opacity="0.5" />
    </IconBase>
  ),
  Plus: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  ),
  Layers: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 2 2 7l10 5 10-5-10-5z" />
      <path d="m2 12 10 5 10-5" />
      <path d="m2 17 10 5 10-5" />
    </IconBase>
  ),
  Shield: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 2 4 5v7c0 4.4 3.5 8.5 8 10 4.5-1.5 8-5.6 8-10V5l-8-3z" />
    </IconBase>
  ),
  Logs: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 4h16v16H4z" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </IconBase>
  ),
  Pulse: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </IconBase>
  ),
  Settings: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </IconBase>
  ),
  Wallet: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M19 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
      <path d="M16 14h.01" />
      <path d="M3 9V7a2 2 0 0 1 2-2h12" />
    </IconBase>
  ),
  ArrowRight: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M5 12h14M13 5l7 7-7 7" />
    </IconBase>
  ),
  ArrowDown: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 5v14M5 12l7 7 7-7" />
    </IconBase>
  ),
  ArrowUpRight: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M7 17 17 7M7 7h10v10" />
    </IconBase>
  ),
  Check: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M20 6 9 17l-5-5" />
    </IconBase>
  ),
  X: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </IconBase>
  ),
  Close: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </IconBase>
  ),
  Clock: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </IconBase>
  ),
  Calendar: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </IconBase>
  ),
  Copy: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </IconBase>
  ),
  External: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </IconBase>
  ),
  Search: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </IconBase>
  ),
  Filter: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 4h18l-7 9v6l-4 2v-8z" />
    </IconBase>
  ),
  ChevronDown: (p: IconProps) => (
    <IconBase {...p}>
      <path d="m6 9 6 6 6-6" />
    </IconBase>
  ),
  ChevronRight: (p: IconProps) => (
    <IconBase {...p}>
      <path d="m9 6 6 6-6 6" />
    </IconBase>
  ),
  ChevronLeft: (p: IconProps) => (
    <IconBase {...p}>
      <path d="m15 6-6 6 6 6" />
    </IconBase>
  ),
  Download: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </IconBase>
  ),
  Upload: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
    </IconBase>
  ),
  Sparkle: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </IconBase>
  ),
  Bell: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M13.7 21a2 2 0 0 1-3.4 0" />
    </IconBase>
  ),
  Inbox: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5 8 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6L19 8z" />
    </IconBase>
  ),
  Coins: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82" />
    </IconBase>
  ),
  Lock: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </IconBase>
  ),
  Hash: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
    </IconBase>
  ),
  Refresh: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 12a9 9 0 0 0-15-6.7L3 8M3 3v5h5M3 12a9 9 0 0 0 15 6.7L21 16M21 21v-5h-5" />
    </IconBase>
  ),
  Power: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0" />
    </IconBase>
  ),
  Eye: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </IconBase>
  ),
  More: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </IconBase>
  ),
  Spinner: (p: IconProps) => (
    <IconBase {...p} className="spin">
      <path d="M12 2a10 10 0 1 0 10 10" />
    </IconBase>
  ),
  Info: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M11 12h1v5h1" />
    </IconBase>
  ),
  Alert: (p: IconProps) => (
    <IconBase {...p}>
      <path d="m12 3 10 18H2z" />
      <path d="M12 9v5M12 18h.01" />
    </IconBase>
  ),
  Activity: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M22 12h-4l-3 9-6-18-3 9H2" />
    </IconBase>
  ),
  Logo: ({ size = 22, stroke: _stroke, ...rest }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...rest}>
      <defs>
        <linearGradient id="lg-canton" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0" stopColor="var(--accent-2)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <path
        d="M4 8c3 0 3 3 6 3s3-3 6-3 3 3 6 3"
        stroke="url(#lg-canton)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 13c3 0 3 3 6 3s3-3 6-3 3 3 6 3"
        stroke="url(#lg-canton)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <path
        d="M4 18c3 0 3 3 6 3s3-3 6-3 3 3 6 3"
        stroke="url(#lg-canton)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.25"
      />
    </svg>
  ),
} as const;
