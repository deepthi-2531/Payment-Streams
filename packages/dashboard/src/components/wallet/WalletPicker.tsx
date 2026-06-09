/** Hosted multi-wallet picker for wallet layers that expose a wallet list. */

import { useEffect, useState, type CSSProperties } from 'react';
import { ChevronRight, Wallet, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from '../../store/auth.js';
import { walletClient, type StreamsWalletEntry } from '../../store/wallet/index.js';

interface WalletPickerProps {
  readonly onError?: (msg: string) => void;
}

type LoadState = 'loading' | 'ready' | 'error';

export function WalletPicker({ onError }: WalletPickerProps) {
  const auth = useAuth();
  const [entries, setEntries] = useState<readonly StreamsWalletEntry[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // walletClient.listWallets is optional on the contract —
        // if the active layer doesn't define it (dapp-sdk single-
        // wallet path), this component should not have been
        // mounted in the first place. Defend defensively anyway.
        const list = walletClient.listWallets
          ? await walletClient.listWallets()
          : [];
        if (cancelled) return;
        setEntries(list);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        onError?.(msg);
        setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const onPick = async (walletId: string) => {
    setConnecting(walletId);
    try {
      await auth.connect(walletId);
    } finally {
      setConnecting(null);
    }
  };

  if (state === 'loading') {
    return (
      <div style={listStyle}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={skeletonRowStyle} />
        ))}
      </div>
    );
  }

  if (state === 'error' || entries.length === 0) {
    return (
      <div style={emptyStyle}>
        <AlertCircle size={14} />
        No wallets found for this layer.
      </div>
    );
  }

  return (
    <div style={listStyle}>
      {entries.map((w) => (
        <button
          key={w.id}
          type="button"
          onClick={() => void onPick(w.id)}
          disabled={auth.isConnecting || connecting !== null}
          style={rowStyle(w.installed === false)}
          title={w.installed === false && w.installUrl ? `Install at ${w.installUrl}` : undefined}
        >
          <div style={leftCellStyle}>
            <div style={iconCellStyle}>
              <Wallet size={14} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>{w.name}</span>
                {w.cip0103Native && <CipBadge />}
              </div>
              <InstallStateBadge installed={w.installed} installUrl={w.installUrl} />
            </div>
          </div>
          {connecting === w.id ? (
            <Loader2 size={14} style={{ animation: 'spin 800ms linear infinite' }} />
          ) : (
            <ChevronRight size={14} style={{ color: 'var(--fg-4)' }} />
          )}
        </button>
      ))}
    </div>
  );
}

function CipBadge() {
  return (
    <span
      className="mono"
      style={{
        fontSize: 9.5,
        fontWeight: 600,
        padding: '1px 6px',
        borderRadius: 999,
        background: 'var(--accent-soft)',
        color: 'var(--accent)',
      }}
      title="CIP-0103 native wallet"
    >
      CIP-103
    </span>
  );
}

function InstallStateBadge({
  installed,
  installUrl,
}: {
  readonly installed?: boolean;
  readonly installUrl?: string;
}) {
  if (installed === true) {
    return (
      <span style={installedStyle}>
        <CheckCircle2 size={10} /> Installed
      </span>
    );
  }
  if (installed === false) {
    return (
      <span style={notInstalledStyle}>
        Not installed
        {installUrl && <span style={{ marginLeft: 4, color: 'var(--accent)' }}>· install</span>}
      </span>
    );
  }
  return null;
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const skeletonRowStyle: CSSProperties = {
  height: 52,
  borderRadius: 'var(--r-md)',
  background: 'var(--bg-elev)',
  border: '1px solid var(--line)',
  opacity: 0.5,
};

const emptyStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  background: 'var(--bg-elev)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
  fontSize: 12.5,
  color: 'var(--fg-3)',
};

function rowStyle(notInstalled: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '10px 12px',
    background: 'var(--bg-elev)',
    border: '1px solid var(--line-2)',
    borderRadius: 'var(--r-md)',
    cursor: 'pointer',
    transition: 'border 120ms, background 120ms',
    opacity: notInstalled ? 0.7 : 1,
    width: '100%',
    textAlign: 'left',
    color: 'inherit',
    font: 'inherit',
  };
}

const leftCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const iconCellStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  background: 'var(--accent-soft)',
  color: 'var(--accent)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const installedStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 10.5,
  color: 'var(--accent)',
  marginTop: 2,
};

const notInstalledStyle: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--fg-4)',
  marginTop: 2,
};
