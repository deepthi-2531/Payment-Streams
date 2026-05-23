/**
 * Signing — visual primitive shown while a wallet operation is
 * pending (during connect, sign, or prepareExecute).
 *
 * The dapp-sdk picker drives the actual interaction; this component
 * is for the dashboard's own "please confirm in your wallet" panel.
 */

import type { CSSProperties } from 'react';
import { Loader2 } from 'lucide-react';

export interface SigningProps {
  readonly label: string;
  readonly subLabel?: string;
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: 16,
  background: 'var(--bg-elev)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
};

const iconStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 10,
  background: 'color-mix(in oklab, var(--accent) 14%, var(--card))',
  border: '1px solid var(--accent-line, var(--line-2))',
  color: 'var(--accent)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

export function Signing({ label, subLabel }: SigningProps) {
  return (
    <div style={wrapStyle}>
      <div style={iconStyle}>
        <Loader2
          size={18}
          style={{ animation: 'spin 800ms linear infinite' }}
        />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
          {label}
        </div>
        {subLabel && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-4)', marginTop: 2 }}>
            {subLabel}
          </div>
        )}
      </div>
    </div>
  );
}
