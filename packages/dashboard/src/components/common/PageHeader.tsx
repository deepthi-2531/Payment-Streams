/**
 * PageHeader — title + subtitle + optional actions row.
 * Used by all pages in the cc-streams design system.
 */

import type { CSSProperties, ReactNode } from 'react';

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const wrapperStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: 16,
  marginBottom: 28,
  flexWrap: 'wrap',
};

const titleStyle: CSSProperties = {
  fontSize: 28,
  fontWeight: 500,
  letterSpacing: '-0.02em',
  margin: 0,
  color: 'var(--fg)',
  lineHeight: 1.1,
};

const subtitleStyle: CSSProperties = {
  margin: '6px 0 0',
  fontSize: 13.5,
  color: 'var(--fg-3)',
};

export function PageHeader({ title, subtitle, actions, className, style }: PageHeaderProps) {
  return (
    <div className={className} style={{ ...wrapperStyle, ...style }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={titleStyle}>{title}</h1>
        {subtitle && <div style={subtitleStyle}>{subtitle}</div>}
      </div>
      {actions && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {actions}
        </div>
      )}
    </div>
  );
}

/** Smaller section divider used between page-internal regions. */
export interface SectionHeaderProps {
  readonly title: ReactNode;
  readonly count?: number;
  readonly action?: ReactNode;
}

const sectionStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 12,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--fg-2)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const countStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--fg-4)',
  padding: '2px 8px',
  border: '1px solid var(--line)',
  borderRadius: 999,
};

export function SectionHeader({ title, count, action }: SectionHeaderProps) {
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>{title}</span>
        {count !== undefined && <span style={countStyle}>{count}</span>}
      </div>
      {action}
    </div>
  );
}
