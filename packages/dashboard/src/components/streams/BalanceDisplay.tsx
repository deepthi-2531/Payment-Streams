/**
 * BalanceDisplay — STR-116 Phase 5 reskin to cc-streams dark theme.
 *
 * 4-up grid of balance cards (Accrued / Withdrawable / Refundable /
 * Progress). Highlights "Withdrawable" with var(--accent) and renders
 * the progress bar with the cc-streams .flow-bar primitive.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { StreamBalances } from '@canton-streams/sdk/browser';
import { AmountDisplay } from '../common/AmountDisplay.js';

export interface BalanceDisplayProps {
  readonly balances: StreamBalances;
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
};

export function BalanceDisplay({ balances }: BalanceDisplayProps) {
  return (
    <div style={gridStyle}>
      <BalanceCard
        label="Accrued"
        value={<AmountDisplay amount={balances.accrued} />}
        sublabel="Total vested"
      />
      <BalanceCard
        label="Withdrawable"
        value={<AmountDisplay amount={balances.withdrawable} />}
        sublabel="Available now"
        highlight
      />
      <BalanceCard
        label="Refundable"
        value={<AmountDisplay amount={balances.refundable} />}
        sublabel="On cancel"
      />
      <BalanceCard
        label="Progress"
        value={
          <span className="mono">
            {balances.percentComplete.toFixed(1)}%
          </span>
        }
        sublabel={`${balances.alreadyWithdrawn.toFixed(2)} withdrawn`}
        progressBar={balances.percentComplete}
      />
    </div>
  );
}

interface BalanceCardProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly sublabel: string;
  readonly highlight?: boolean;
  readonly progressBar?: number;
}

const cardStyle: CSSProperties = {
  padding: 16,
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  color: 'var(--fg-4)',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  margin: 0,
};

const valueStyle = (highlight: boolean): CSSProperties => ({
  marginTop: 8,
  fontSize: 22,
  fontWeight: 500,
  color: highlight ? 'var(--accent)' : 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
  fontFamily: 'var(--font-mono)',
  lineHeight: 1.1,
});

const sublabelStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 11,
  color: 'var(--fg-4)',
};

function BalanceCard({
  label,
  value,
  sublabel,
  highlight = false,
  progressBar,
}: BalanceCardProps) {
  return (
    <div className="card" style={cardStyle}>
      <p style={labelStyle}>{label}</p>
      <p style={valueStyle(highlight)}>{value}</p>
      <p style={sublabelStyle}>{sublabel}</p>
      {progressBar !== undefined && (
        <div className="flow-bar static" style={{ marginTop: 10 }}>
          <div
            className="fill"
            style={{
              width: `${Math.min(100, Math.max(0, progressBar))}%`,
            }}
          />
        </div>
      )}
    </div>
  );
}
