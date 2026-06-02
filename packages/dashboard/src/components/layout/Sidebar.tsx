/**
 * Sidebar — Canton Streams left-rail navigation.
 *
 * Rebuilt from the mock at `Canton Streams/src/shell.jsx`. Uses the design
 * tokens + primitives from Phase 1 (STR-111). The identity card at the
 * bottom reads from the real `useAuth()` context — no mock identity.
 *
 * The pending-count badge on Inbox stays at zero until Phase 6 (STR-122)
 * adds the InboxPage + outgoing-pending query.
 *
 * STR-112 — Phase 2 of the UI integration.
 */
import { useState, type CSSProperties } from 'react';
import { NavLink, useLocation } from 'react-router';
import { Icons } from '../primitives/Icons.js';
import { Avatar } from '../primitives/Avatar.js';
import { partyShort } from '../primitives/PartyChip.js';
import { useAuth } from '../../store/auth.js';
import { useStreams } from '../../hooks/useStreams.js';

interface NavItem {
  readonly route: string;
  readonly label: string;
  readonly icon: keyof typeof Icons;
  readonly badgeKey?: 'inbox';
  readonly divider?: false;
}
interface NavDivider {
  readonly divider: true;
}
type NavEntry = NavItem | NavDivider;

const NAV: ReadonlyArray<NavEntry> = [
  { route: '/', label: 'Dashboard', icon: 'Dashboard' },
  { route: '/streams', label: 'Streams', icon: 'Stream' },
  { route: '/create', label: 'Create', icon: 'Plus' },
  { route: '/batch', label: 'Batch', icon: 'Layers' },
  { route: '/inbox', label: 'Inbox', icon: 'Inbox', badgeKey: 'inbox' },
  { divider: true },
  { route: '/policies', label: 'Policies', icon: 'Shield' },
  { route: '/executor', label: 'Executor', icon: 'Pulse' },
  { route: '/execution-logs', label: 'Execution Logs', icon: 'Logs' },
  { divider: true },
  { route: '/settings', label: 'Settings', icon: 'Settings' },
];

export function Sidebar() {
  const location = useLocation();
  const auth = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Inbox badge shows the count of incoming streams (streams where the
  // connected party is the recipient). The dashboard does not run a
  // propose/accept ceremony today — funding approval happens in the
  // wallet — so a "pending requests" count would always be zero and
  // misleading. Switched to the active-streams hook.
  const incoming = useStreams(auth.party ? { recipient: auth.party } : undefined);
  const pendingCount = incoming.data?.length ?? 0;

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
        className="cc-mobile-hamburger"
        style={mobileHamburgerStyle}
      >
        <Icons.More size={20} />
      </button>

      {/* Backdrop for mobile */}
      {mobileOpen && (
        <div onClick={() => setMobileOpen(false)} style={mobileBackdropStyle} />
      )}

      <aside
        className={mobileOpen ? 'cc-sidebar cc-sidebar--open' : 'cc-sidebar'}
        style={sidebarStyle(mobileOpen)}
      >
        {/* Brand */}
        <div style={brandStyle}>
          <Icons.Logo size={26} />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '-0.01em' }}>
              CC Streams
            </span>
            <span
              className="mono"
              style={{ fontSize: 9.5, color: 'var(--fg-4)', letterSpacing: '0.05em' }}
            >
              v0.2.7
            </span>
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--line)', marginBottom: 8 }} />

        <nav style={navStyle}>
          {NAV.map((item, i) => {
            if ('divider' in item && item.divider) {
              return (
                <div
                  key={`div-${i}`}
                  style={{
                    height: 1,
                    background: 'var(--line)',
                    margin: '8px 6px',
                  }}
                />
              );
            }
            const navItem = item as NavItem;
            const Icon = Icons[navItem.icon];
            const isActive =
              location.pathname === navItem.route ||
              (navItem.route === '/streams' && location.pathname.startsWith('/streams/'));
            const badge =
              navItem.badgeKey === 'inbox' && pendingCount > 0 ? pendingCount : null;
            return (
              <NavLink
                key={navItem.route}
                to={navItem.route}
                end={navItem.route === '/'}
                onClick={() => setMobileOpen(false)}
                style={({ isActive: rrActive }) =>
                  navLinkStyle(rrActive || isActive)
                }
              >
                {({ isActive: rrActive }) => (
                  <>
                    {(rrActive || isActive) && <span style={activeBarStyle} />}
                    <Icon size={15} />
                    <span style={{ flex: 1 }}>{navItem.label}</span>
                    {badge !== null && (
                      <span
                        className="mono"
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          background: 'var(--warn-soft)',
                          color: 'var(--warn)',
                          padding: '1px 6px',
                          borderRadius: 999,
                        }}
                      >
                        {badge}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Identity card — real auth state, no mock */}
        <div style={identityCardStyle}>
          <div
            style={{
              fontSize: 9.5,
              color: 'var(--fg-4)',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginBottom: 8,
            }}
          >
            Connected Party
          </div>
          {auth.isAuthenticated && auth.party ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar
                  identity={{ name: auth.party.split('::')[0] }}
                  size={30}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: 'var(--fg)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={auth.party}
                  >
                    {auth.party.split('::')[0]}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 10.5, color: 'var(--fg-4)' }}
                  >
                    {partyShort(auth.party)}…
                  </div>
                </div>
                <button
                  className="btn-ghost"
                  style={{ padding: 6, borderRadius: 6 }}
                  onClick={auth.clearCredentials}
                  title="Disconnect wallet"
                >
                  <Icons.Power size={14} />
                </button>
              </div>
              <div style={{ height: 1, background: 'var(--line)', margin: '10px 0' }} />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 10.5,
                  color: 'var(--fg-3)',
                }}
              >
                <span>Wallet</span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    color: 'var(--accent)',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      background: 'var(--accent)',
                      borderRadius: '50%',
                    }}
                  />{' '}
                  CIP-103
                </span>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--fg-4)' }}>
              Not connected · Settings → Connect
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline styles — kept here rather than in cc-streams.css because they
// depend on dynamic state (mobileOpen). Static base styles still live in
// cc-streams.css; this layer just applies positioning + transitions.
// ---------------------------------------------------------------------------

const mobileHamburgerStyle: CSSProperties = {
  position: 'fixed',
  top: 14,
  left: 12,
  zIndex: 50,
  padding: 8,
  borderRadius: 8,
  background: 'var(--card)',
  color: 'var(--fg-2)',
  border: '1px solid var(--line-2)',
  display: 'none', // shown via media query in CSS below
};

const mobileBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40,
  background: 'rgba(0, 0, 0, 0.5)',
  backdropFilter: 'blur(4px)',
};

function sidebarStyle(_mobileOpen: boolean): CSSProperties {
  return {
    background:
      'linear-gradient(180deg, color-mix(in oklab, var(--card) 80%, transparent) 0%, var(--bg-elev) 100%)',
    borderRight: '1px solid var(--line)',
    display: 'flex',
    flexDirection: 'column',
    padding: '18px 14px',
    position: 'relative',
    height: '100%',
  };
}

const brandStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '4px 10px 16px',
};

const navStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  flex: 1,
};

const activeBarStyle: CSSProperties = {
  position: 'absolute',
  left: -14,
  top: 8,
  bottom: 8,
  width: 2,
  background: 'var(--accent)',
  borderRadius: 2,
};

function navLinkStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '8px 10px',
    fontSize: 13,
    fontWeight: 500,
    borderRadius: 8,
    color: active ? 'var(--fg)' : 'var(--fg-3)',
    background: active
      ? 'color-mix(in oklab, var(--accent) 10%, var(--card-2))'
      : 'transparent',
    position: 'relative',
    textAlign: 'left',
    textDecoration: 'none',
    transition: 'background 100ms, color 100ms',
  };
}

const identityCardStyle: CSSProperties = {
  padding: 12,
  background: 'var(--card)',
  border: '1px solid var(--line-2)',
  borderRadius: 12,
};
