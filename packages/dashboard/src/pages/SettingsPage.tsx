/** Settings for proxy health and the active wallet/dev session. */

import { useState, type CSSProperties } from 'react';
import { Shield, Wifi, WifiOff, AlertTriangle } from 'lucide-react';
import { useAuth } from '../store/auth.js';
import { useHealth } from '../hooks/useHealth.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
} from '../components/common/index.js';
import { Copyable } from '../components/primitives/Copyable.js';

export function SettingsPage() {
  return (
    <div style={{ paddingTop: 28, maxWidth: 760 }}>
      <PageHeader
        title="Settings"
        subtitle="Proxy connection status and authentication configuration."
      />

      {/* Proxy Connection card */}
      <SectionCard
        icon={<Wifi size={16} style={{ color: 'var(--fg-3)' }} />}
        title="Proxy Connection"
        subtitle="Canton connection is managed server-side via environment variables."
      >
        <ConnectionStatus />
      </SectionCard>

      <div style={{ height: 24 }} />

      {/* Wallet session card */}
      <SectionCard
        icon={<Shield size={16} style={{ color: 'var(--fg-3)' }} />}
        title="Wallet session"
        subtitle="Connect a wallet for normal use. The dev-mode fallback is only for local development."
      >
        <ConnectForm />
      </SectionCard>
    </div>
  );
}

function SectionCard({
  icon,
  title,
  subtitle,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly subtitle: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{ padding: 20, borderBottom: '1px solid var(--line)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 4,
          }}
        >
          {icon}
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>
            {title}
          </h3>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-4)' }}>
          {subtitle}
        </p>
      </div>
      <div style={{ padding: 20 }}>{children}</div>
    </div>
  );
}

/** Read-only connection status fetched from the proxy health endpoint. */
function ConnectionStatus() {
  const healthQ = useHealth();

  if (healthQ.isPending) {
    return <Skeleton.Row count={1} height={48} />;
  }

  if (healthQ.isError) {
    return (
      <ErrorState
        error={healthQ.error}
        title="Proxy unreachable"
        onRetry={() => healthQ.refetch()}
      />
    );
  }

  const health = healthQ.data;
  if (!health) return null;

  const failingChecks = health.readiness?.checks
    ? Object.entries(health.readiness.checks).filter(([, c]) => c.status === 'error')
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {health.status === 'degraded' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '12px 14px',
            borderRadius: 12,
            background: 'var(--warn-soft)',
            border: '1px solid color-mix(in oklab, var(--warn) 30%, transparent)',
          }}
        >
          <AlertTriangle size={18} style={{ color: 'var(--warn)', marginTop: 1 }} />
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
              Proxy reachable, readiness failed
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--fg-3)' }}>
              The proxy can be reached, but startup checks found a deployment issue.
            </p>
            {failingChecks.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {failingChecks.map(([name, check]) => (
                  <div
                    key={name}
                    style={{
                      background: 'var(--card-2)',
                      padding: '6px 10px',
                      borderRadius: 6,
                      fontSize: 11.5,
                      color: 'var(--fg-2)',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{name}</span>: {check.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 14px',
            borderRadius: 12,
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent-line)',
          }}
        >
          <Wifi size={18} style={{ color: 'var(--accent)' }} />
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
              Proxy connected
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--fg-3)' }}>
              Canton ledger reachable
            </p>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <span className="badge" style={hostBadgeStyle}>
          Host:{' '}
          <Copyable value={health.canton.host} display={health.canton.host} size={11} />
        </span>
        <span className="badge" style={hostBadgeStyle}>
          Port: <span className="mono">{health.canton.port}</span>
        </span>
      </div>

      {/* Suppress unused warning for WifiOff (kept for future disconnect state). */}
      <span style={{ display: 'none' }}>
        <WifiOff size={0} />
      </span>
    </div>
  );
}

const hostBadgeStyle: CSSProperties = {
  background: 'var(--card-2)',
  border: '1px solid var(--line-2)',
  color: 'var(--fg-2)',
  fontSize: 11.5,
};

/** Wallet session panel. */
export function ConnectForm() {
  const {
    isAuthenticated,
    party,
    accounts,
    signingProviderId,
    network,
    provider,
    devMode,
    isConnecting,
    error,
    connect,
    disconnect,
    setDevCredentials,
  } = useAuth();

  const [showDev, setShowDev] = useState(false);
  const [token, setToken] = useState('');
  const [partyInput, setPartyInput] = useState('');

  const handleDevConnect = () => {
    if (partyInput) {
      setDevCredentials(token || 'dev-mode', partyInput);
      setToken('');
      setPartyInput('');
    }
  };

  if (isAuthenticated) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            borderRadius: 12,
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent-line)',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--fg)',
              }}
            >
              {devMode ? 'Dev session active' : 'Wallet connected'}
            </p>
            <p
              className="mono"
              style={{
                margin: '4px 0 0',
                fontSize: 12,
                color: 'var(--fg-3)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={party ?? ''}
            >
              {party}
            </p>
          </div>
          <button
            onClick={() => {
              void disconnect();
            }}
            className="btn btn-ghost btn-sm"
          >
            Disconnect
          </button>
        </div>

        {!devMode && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
              fontSize: 11.5,
            }}
          >
            <Meta k="Provider" v={provider?.id ?? '—'} />
            <Meta k="Signing" v={signingProviderId ?? '—'} />
            <Meta k="Network" v={network?.networkId ?? '—'} />
            <Meta k="Accounts" v={String(accounts.length)} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button
        type="button"
        onClick={() => void connect()}
        disabled={isConnecting}
        className="btn btn-primary"
        style={{ width: '100%' }}
      >
        {isConnecting ? 'Opening wallet…' : 'Connect wallet'}
      </button>

      {error && (
        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            color: 'var(--danger)',
          }}
        >
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => setShowDev((v) => !v)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--fg-3)',
          fontSize: 11.5,
          cursor: 'pointer',
          padding: 0,
          textAlign: 'left',
        }}
      >
        {showDev ? 'Hide' : 'Use'} dev-mode credentials
      </button>

      {showDev && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label className="label" htmlFor="settings-party">
              Party
            </label>
            <input
              id="settings-party"
              className="input mono"
              value={partyInput}
              onChange={(e) => setPartyInput(e.target.value)}
              placeholder="alice::1220abcd…"
            />
          </div>
          <div>
            <label className="label" htmlFor="settings-token">
              JWT Token (optional in dev)
            </label>
            <input
              id="settings-token"
              className="input mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder="eyJ…"
            />
          </div>
          <button
            type="button"
            onClick={handleDevConnect}
            disabled={!partyInput}
            className="btn btn-secondary"
            style={{ width: '100%' }}
          >
            Connect dev session
          </button>
          <p style={{ margin: 0, fontSize: 10.5, color: 'var(--fg-4)' }}>
            Dev mode bypasses the wallet; use it only against a local development proxy.
          </p>
        </div>
      )}
    </div>
  );
}

function Meta({ k, v }: { readonly k: string; readonly v: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--fg-4)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: 4,
        }}
      >
        {k}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 11.5,
          color: 'var(--fg-2)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={v}
      >
        {v}
      </div>
    </div>
  );
}
