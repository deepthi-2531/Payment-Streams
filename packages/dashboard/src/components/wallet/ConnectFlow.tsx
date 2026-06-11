/**
 * ConnectFlow — split-screen landing page shown when the user has no
 * wallet session yet.
 *
 * Left: brand + tagline + a couple of stat badges.
 * Right: a connect card that calls `auth.connect()` (picker or direct
 *        LocalNet gateway, depending on config), plus a dev-mode fallback
 *        for environments without a real wallet.
 *
 * Hosted-wallet layers render a wallet list; single-wallet layers render a
 * direct connect button.
 */

import { useState, type CSSProperties } from 'react';
import { AlertCircle, ChevronRight, KeyRound, Wallet } from 'lucide-react';
import { useAuth } from '../../store/auth.js';
import { walletClient } from '../../store/wallet/index.js';
import { Signing } from './Signing.js';
import { WalletPicker } from './WalletPicker.js';

const wrapStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'grid',
  gridTemplateColumns: '1.1fr 1fr',
  background: 'var(--bg)',
  color: 'var(--fg)',
};

const leftStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  padding: '40px 56px',
  background:
    'radial-gradient(120% 80% at 0% 0%, color-mix(in oklab, var(--accent) 10%, var(--bg)) 0%, var(--bg) 60%)',
};

const rightStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 40,
};

const cardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 420,
  background: 'color-mix(in oklab, var(--card) 92%, transparent)',
  border: '1px solid var(--line-2)',
  borderRadius: 20,
  padding: 28,
  backdropFilter: 'blur(20px)',
  boxShadow: '0 20px 60px -10px rgba(0,0,0,0.5)',
};

const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  background: 'var(--bg-elev)',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-sm)',
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--fg)',
  outline: 'none',
  fontFamily: 'var(--font-mono)',
};

export function ConnectFlow() {
  const auth = useAuth();
  const [showDev, setShowDev] = useState(false);
  const [devToken, setDevToken] = useState('');
  const [devParty, setDevParty] = useState('');

  const handleConnect = () => {
    void auth.connect();
  };

  const handleDevConnect = () => {
    if (devParty) {
      auth.setDevCredentials(devToken || 'dev-mode', devParty);
      setDevToken('');
      setDevParty('');
    }
  };

  return (
    <div style={wrapStyle}>
      {/* LEFT — brand */}
      <div style={leftStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              background: 'var(--accent)',
              color: '#06090d',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
            }}
          >
            CS
          </div>
          <span style={{ fontSize: 16, fontWeight: 500 }}>Canton Streams</span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: 'var(--fg-4)',
              marginLeft: 6,
              padding: '2px 6px',
              border: '1px solid var(--line)',
              borderRadius: 4,
            }}
          >
            v1.0.0-rc.1
          </span>
        </div>

        <div style={{ maxWidth: 460 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--accent)',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              marginBottom: 18,
            }}
          >
            continuous payment streaming
          </div>
          <h1
            style={{
              fontSize: 44,
              fontWeight: 500,
              lineHeight: 1.05,
              letterSpacing: '-0.03em',
              margin: '0 0 18px',
            }}
          >
            Stream value, second
            <br />
            by second.
          </h1>
          <p
            style={{
              fontSize: 14.5,
              color: 'var(--fg-2)',
              lineHeight: 1.55,
              margin: 0,
            }}
          >
            Time-locked, vesting-aware payment rails on the Canton ledger. Linear, cliff, stepped,
            or renewable — every choice settles on real custody, every accrual is real-time.
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 28,
            fontSize: 11.5,
            color: 'var(--fg-3)',
          }}
        >
          <Stat label="Settlement" value="On ledger" sub="atomic" />
          <Stat label="Standard" value="CIP-56 V2" sub="AllocationRequest" />
          <Stat label="Auth" value="CIP-103" sub="Amulet wallet" />
        </div>
      </div>

      {/* RIGHT — connect card */}
      <div style={rightStyle}>
        <div style={cardStyle}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 18,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: 'color-mix(in oklab, var(--accent) 14%, var(--card))',
                color: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Wallet size={16} />
            </div>
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: 16,
                  fontWeight: 500,
                  color: 'var(--fg)',
                }}
              >
                Connect wallet
              </h2>
              <p
                style={{
                  margin: '2px 0 0',
                  fontSize: 11.5,
                  color: 'var(--fg-4)',
                }}
              >
                {walletClient.capabilities.hostedMultiWallet
                  ? `${walletClient.name} · pick a wallet`
                  : 'Splice Amulet Wallet · CIP-103'}
              </p>
            </div>
          </div>

          {auth.isConnecting ? (
            <Signing
              label="Confirm in your wallet"
              subLabel="The picker will open in a new window if not already shown."
            />
          ) : walletClient.capabilities.hostedMultiWallet ? (
            <WalletPicker />
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConnect}
              disabled={auth.isConnecting}
              style={{ width: '100%', padding: '10px 14px', fontSize: 14 }}
            >
              <Wallet size={14} /> Connect wallet
              <ChevronRight size={14} style={{ marginLeft: 'auto' }} />
            </button>
          )}

          {auth.error && (
            <div
              style={{
                marginTop: 14,
                display: 'flex',
                gap: 8,
                padding: '10px 12px',
                background: 'color-mix(in oklab, var(--danger) 8%, var(--bg-elev))',
                border: '1px solid color-mix(in oklab, var(--danger) 30%, var(--line))',
                borderRadius: 'var(--r-md)',
                fontSize: 11.5,
                color: 'var(--danger)',
              }}
            >
              <AlertCircle size={14} style={{ flexShrink: 0 }} />
              {auth.error}
            </div>
          )}

          <div
            style={{
              marginTop: 18,
              paddingTop: 18,
              borderTop: '1px solid var(--line)',
            }}
          >
            <button
              type="button"
              onClick={() => setShowDev((v) => !v)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--fg-3)',
                fontSize: 11.5,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: 0,
              }}
            >
              <KeyRound size={12} />
              {showDev ? 'Hide' : 'Use'} dev-mode credentials
            </button>

            {showDev && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleDevConnect();
                }}
                style={{
                  marginTop: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <input
                  value={devParty}
                  onChange={(e) => setDevParty(e.target.value)}
                  style={inputStyle}
                  placeholder="alice::1220abcd…"
                  aria-label="Party"
                />
                <input
                  type="password"
                  value={devToken}
                  onChange={(e) => setDevToken(e.target.value)}
                  style={inputStyle}
                  placeholder="JWT (optional in dev)"
                  aria-label="JWT token"
                />
                <button
                  type="submit"
                  className="btn btn-secondary"
                  disabled={!devParty}
                  style={{ width: '100%' }}
                >
                  Connect dev session
                </button>
                <p style={{ margin: 0, fontSize: 10.5, color: 'var(--fg-4)' }}>
                  Dev mode bypasses the wallet; use it only against a local development proxy.
                </p>
              </form>
            )}
          </div>

          <div
            style={{
              marginTop: 18,
              paddingTop: 12,
              borderTop: '1px solid var(--line)',
              fontSize: 10.5,
              color: 'var(--fg-4)',
              lineHeight: 1.6,
            }}
          >
            By connecting you grant the dashboard:{' '}
            <span className="mono" style={{ color: 'var(--fg-3)' }}>
              listAccounts
            </span>
            ,{' '}
            <span className="mono" style={{ color: 'var(--fg-3)' }}>
              prepareExecute
            </span>
            ,{' '}
            <span className="mono" style={{ color: 'var(--fg-3)' }}>
              signMessage
            </span>
            ,{' '}
            <span className="mono" style={{ color: 'var(--fg-3)' }}>
              subscribe:txChanged
            </span>
            .
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  readonly label: string;
  readonly value: string;
  readonly sub: string;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 9.5,
          color: 'var(--fg-4)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 16,
          fontWeight: 500,
          color: 'var(--fg)',
          letterSpacing: '-0.01em',
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--fg-4)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}
