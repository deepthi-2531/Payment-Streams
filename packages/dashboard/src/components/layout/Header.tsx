/**
 * Header / TopBar — Canton Streams app top bar.
 *
 * Rebuilt from the mock at `Canton Streams/src/shell.jsx`. The network
 * chip's label is derived from the live `/api/health` proxy response —
 * no hardcoded `canton:da-testnet`. When health is unreachable the chip
 * shows `canton:disconnected` so the user gets immediate feedback.
 *
 * Dashboard header.
 */
import type { CSSProperties } from 'react';
import { useLocation } from 'react-router';
import { Icons } from '../primitives/Icons.js';
import { useHealth, networkLabelFromHost } from '../../hooks/useHealth.js';

const ROUTE_LABELS: Readonly<Record<string, string>> = {
  '/': 'Dashboard',
  '/streams': 'Streams',
  '/create': 'Create Stream',
  '/batch': 'Batch Create',
  '/inbox': 'Inbox',
  '/policies': 'Delegated Policies',
  '/executor': 'Executor Status',
  '/execution-logs': 'Execution Logs',
  '/settings': 'Settings',
};

function routeLabel(pathname: string): string {
  // Stream detail: `/streams/:sender/:streamId`
  if (pathname.startsWith('/streams/')) return 'Stream Detail';
  return ROUTE_LABELS[pathname] ?? 'Canton Streams';
}

export function Header() {
  const location = useLocation();
  const health = useHealth();

  const networkLabel = health.isError
    ? 'canton:disconnected'
    : networkLabelFromHost(health.data?.canton?.host);
  const networkOk = !health.isError && health.data?.status === 'ok';

  return (
    <div style={topBarStyle}>
      {/* Breadcrumb */}
      <div style={breadcrumbStyle}>
        <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>CC Streams</span>
        <Icons.ChevronRight size={12} className="muted" />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
          {routeLabel(location.pathname)}
        </span>
      </div>

      {/* Network chip — driven by useHealth */}
      <div
        className={networkOk ? 'badge accent' : 'badge'}
        style={{ paddingLeft: 6 }}
        title={
          health.data?.canton
            ? `${health.data.canton.host}:${health.data.canton.port}`
            : 'Proxy unreachable'
        }
      >
        {networkOk && <span className="pulse" />}
        <span className="mono" style={{ fontSize: 10.5 }}>
          {networkLabel}
        </span>
      </div>

      {/* Search placeholder */}
      <div style={searchStyle}>
        <Icons.Search size={13} />
        <input
          placeholder="Search streams, parties…"
          style={searchInputStyle}
          aria-label="Search"
        />
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: 'var(--fg-5)',
            padding: '1px 5px',
            border: '1px solid var(--line-2)',
            borderRadius: 4,
          }}
        >
          ⌘K
        </span>
      </div>

      <button className="btn btn-ghost btn-icon" title="Notifications">
        <Icons.Bell size={15} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles — these mirror the mock's shell.jsx exactly; kept here
// so the topbar component is self-contained (no globals.css cross-file
// dependency beyond the design tokens).
// ---------------------------------------------------------------------------

const topBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '20px 32px',
  borderBottom: '1px solid transparent',
  position: 'sticky',
  top: 0,
  zIndex: 10,
  background: 'color-mix(in oklab, var(--bg) 80%, transparent)',
  backdropFilter: 'blur(8px)',
};

const breadcrumbStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const searchStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'var(--card-2)',
  border: '1px solid var(--line)',
  padding: '6px 10px',
  borderRadius: 8,
  width: 220,
  color: 'var(--fg-4)',
};

const searchInputStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'var(--fg-2)',
  fontSize: 12.5,
  width: '100%',
};
