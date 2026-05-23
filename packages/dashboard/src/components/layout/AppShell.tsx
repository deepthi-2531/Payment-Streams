/**
 * AppShell — top-level layout wrapper.
 *
 * Rebuilt from the mock at `Canton Streams/src/shell.jsx`. Provides the
 * 232px sidebar + flex main content grid. The `<Outlet />` slot renders
 * the active route's page.
 *
 * STR-112 — Phase 2 of the UI integration.
 */
import type { CSSProperties } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Sidebar } from './Sidebar.js';
import { Header } from './Header.js';

export function AppShell() {
  const location = useLocation();
  return (
    <div style={shellStyle}>
      <Sidebar />
      <main style={mainStyle}>
        <Header />
        {/* `key={pathname}` triggers the .fade-in keyframe on route change */}
        <div
          key={location.pathname}
          className="fade-in"
          style={{ padding: '0 32px 56px', maxWidth: 1300 }}
        >
          <Outlet />
        </div>
      </main>
    </div>
  );
}

const shellStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '232px 1fr',
  height: '100vh',
  position: 'relative',
  zIndex: 1,
};

const mainStyle: CSSProperties = {
  overflow: 'auto',
  position: 'relative',
};
