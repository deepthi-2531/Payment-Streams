/**
 * SelectProvider — visual label for the wallet's signing provider.
 *
 * The dapp-sdk wallet picker already lets the user choose their wallet
 * and signing provider. After connect, this component surfaces *which*
 * provider the connected account ended up using, so dashboard operators
 * can confirm their session at a glance (Settings page, status pill).
 *
 * No selection happens here — the actual provider chosen via
 * dapp-sdk's built-in picker.
 */

import type { CSSProperties } from 'react';
import { Boxes, Building2, Cpu, KeyRound, ShieldCheck } from 'lucide-react';

export interface SelectProviderProps {
  readonly signingProviderId: string | null;
  readonly compact?: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  'wallet-gateway-internal': 'Wallet-Gateway-Internal',
  'wallet-gateway': 'Wallet-Gateway-Internal',
  participant: 'Participant',
  fireblocks: 'Fireblocks',
  blockdaemon: 'Blockdaemon',
  dfns: 'Dfns',
};

const PROVIDER_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  'wallet-gateway-internal': KeyRound,
  'wallet-gateway': KeyRound,
  participant: Cpu,
  fireblocks: ShieldCheck,
  blockdaemon: Boxes,
  dfns: Building2,
};

export function SelectProvider({
  signingProviderId,
  compact = false,
}: SelectProviderProps) {
  if (!signingProviderId) return null;

  const key = signingProviderId.toLowerCase();
  const label = PROVIDER_LABELS[key] ?? signingProviderId;
  const Icon = PROVIDER_ICONS[key] ?? KeyRound;

  if (compact) {
    return (
      <span className="badge accent" style={badgeStyle}>
        <Icon size={11} />
        {label}
      </span>
    );
  }

  return (
    <div style={fullStyle}>
      <div style={iconWrap}>
        <Icon size={16} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 10,
            color: 'var(--fg-4)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Signing provider
        </div>
        <div
          className="mono"
          style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 500 }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 10.5,
};

const fullStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: 12,
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
  background: 'var(--bg-elev)',
};

const iconWrap: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: 'color-mix(in oklab, var(--accent) 18%, var(--card))',
  border: '1px solid var(--accent-line, var(--line-2))',
  color: 'var(--accent)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};
