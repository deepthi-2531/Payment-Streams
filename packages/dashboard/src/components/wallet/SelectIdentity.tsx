/**
 * SelectIdentity — account picker shown when the connected wallet
 * exposes more than one account.
 *
 * After `sdk.connect()`, `sdk.listAccounts()` returns every account
 * the user authorized. Most wallets return a single account marked
 * `primary: true`, but some (institutional / multi-party) return
 * several. This component lets the operator pick which one drives
 * the session.
 */

import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';
import type { Wallet } from '@canton-network/dapp-sdk';
import { SelectProvider } from './SelectProvider.js';

export interface SelectIdentityProps {
  readonly accounts: readonly Wallet[];
  readonly activePartyId: string | null;
  readonly onPick: (partyId: string) => void;
}

function shortenParty(partyId: string): string {
  if (partyId.length <= 22) return partyId;
  const sep = partyId.indexOf('::');
  if (sep <= 0) return partyId.slice(0, 12) + '…' + partyId.slice(-6);
  return partyId.slice(0, sep) + '::' + partyId.slice(sep + 2, sep + 10) + '…';
}

export function SelectIdentity({
  accounts,
  activePartyId,
  onPick,
}: SelectIdentityProps) {
  if (accounts.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
        Accounts ({accounts.length})
      </div>
      {accounts.map((acct) => {
        const active = acct.partyId === activePartyId;
        return (
          <button
            key={acct.partyId}
            type="button"
            onClick={() => onPick(acct.partyId)}
            style={rowStyle(active)}
          >
            <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: 'var(--fg)',
                  marginBottom: 2,
                }}
              >
                {acct.hint || 'Account'}
                {acct.primary && (
                  <span
                    className="badge accent"
                    style={{ marginLeft: 6, fontSize: 9.5 }}
                  >
                    primary
                  </span>
                )}
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: 'var(--fg-3)' }}
                title={acct.partyId}
              >
                {shortenParty(acct.partyId)}
              </div>
              {acct.signingProviderId && (
                <div style={{ marginTop: 6 }}>
                  <SelectProvider
                    signingProviderId={acct.signingProviderId}
                    compact
                  />
                </div>
              )}
            </div>
            {active && (
              <Check size={14} style={{ color: 'var(--accent)' }} />
            )}
          </button>
        );
      })}
    </div>
  );
}

const rowStyle = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 14px',
  background: active
    ? 'color-mix(in oklab, var(--accent) 10%, var(--bg-elev))'
    : 'var(--bg-elev)',
  border: active
    ? '1px solid var(--accent-line, var(--line-2))'
    : '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
  cursor: 'pointer',
  transition: 'background 120ms, border-color 120ms',
});
