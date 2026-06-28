/** Hosted multi-wallet picker — a dropdown defaulting to the available wallet. */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ChevronDown, Wallet, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from '../../store/auth.js';
import { walletClient, type StreamsWalletEntry } from '../../store/wallet/index.js';

interface WalletPickerProps {
  readonly onError?: (msg: string) => void;
}

type LoadState = 'loading' | 'ready' | 'error';

/** Sort key: installed/available first, unknown next, not-installed last —
 * so the available wallet (e.g. FiveNorth/Loop) is the default selection and
 * the not-installed ones are tucked at the bottom of the dropdown instead of
 * cluttering the screen as greyed-out rows. */
function rank(w: StreamsWalletEntry): number {
  if (w.installed === true) return 0;
  if (w.installed === undefined) return 1;
  return 2;
}

export function WalletPicker({ onError }: WalletPickerProps) {
  const auth = useAuth();
  const [entries, setEntries] = useState<readonly StreamsWalletEntry[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [selected, setSelected] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = walletClient.listWallets ? await walletClient.listWallets() : [];
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => rank(a) - rank(b));
        setEntries(sorted);
        setSelected(sorted[0]?.id ?? '');
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        onError?.(err instanceof Error ? err.message : String(err));
        setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const current = useMemo(
    () => entries.find((w) => w.id === selected),
    [entries, selected],
  );

  const onConnect = async () => {
    if (!selected) return;
    try {
      await auth.connect(selected);
    } catch {
      /* surfaced via auth.error / onError */
    }
  };

  if (state === 'loading') {
    return <div style={skeletonStyle} />;
  }

  if (state === 'error' || entries.length === 0) {
    return (
      <div style={emptyStyle}>
        <AlertCircle size={14} />
        No wallets found for this layer.
      </div>
    );
  }

  const busy = auth.isConnecting;
  const notInstalled = current?.installed === false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={selectWrapStyle}>
        <Wallet size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={busy}
          aria-label="Select wallet"
          style={selectStyle}
        >
          {entries.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.installed === false ? ' — not installed' : ''}
            </option>
          ))}
        </select>
        <ChevronDown size={15} style={{ color: 'var(--fg-4)', flexShrink: 0 }} />
      </div>

      {notInstalled && (
        <div style={hintStyle}>
          This wallet isn’t detected.
          {current?.installUrl && (
            <a
              href={current.installUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: 4, color: 'var(--accent)' }}
            >
              Install ↗
            </a>
          )}
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void onConnect()}
        disabled={busy || !selected}
        style={{ width: '100%', padding: '10px 14px', fontSize: 14, justifyContent: 'center' }}
      >
        {busy ? (
          <Loader2 size={14} style={{ animation: 'spin 800ms linear infinite' }} />
        ) : (
          <>
            <Wallet size={14} /> Connect {current?.name ?? 'wallet'}
          </>
        )}
      </button>
    </div>
  );
}

const selectWrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 12px',
  background: 'var(--bg-elev)',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-md)',
};

const selectStyle: CSSProperties = {
  flex: 1,
  appearance: 'none',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'var(--fg)',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  padding: '11px 4px',
  cursor: 'pointer',
};

const hintStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-4)',
};

const skeletonStyle: CSSProperties = {
  height: 46,
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
