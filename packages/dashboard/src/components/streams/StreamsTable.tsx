/**
 * StreamsTable — card-wrapped stream list.
 *
 * One row per stream with mono stream id, party hints, flow-bar progress,
 * status, vesting, settlement badges, and a link to the detail page.
 */

import { Link } from 'react-router';
import { ArrowUpRight, ListOrdered } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Stream } from '@canton-streams/sdk/browser';
import { SettlementMode, StreamStatus } from '@canton-streams/sdk/browser';
import { StatusBadge } from '../common/StatusBadge.js';

function partyHint(partyId: string): string {
  const sep = partyId.indexOf('::');
  if (sep > 0) return partyId.slice(0, Math.min(sep, 20));
  return partyId.length > 20 ? partyId.slice(0, 16) + '…' : partyId;
}

const SETTLEMENT_LABELS: Record<string, string> = {
  [SettlementMode.NumericLegacy]: 'Legacy',
  [SettlementMode.UtilityHoldingCustody]: 'CIP Custody',
  [SettlementMode.TokenStandardCustody]: 'Token Standard',
  [SettlementMode.LocalAssetCustody]: 'Local Asset',
  [SettlementMode.Delegated]: 'Delegated',
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.4fr 1fr 220px 110px 110px auto',
  alignItems: 'center',
  gap: 16,
  padding: '14px 18px',
  borderBottom: '1px solid var(--line)',
  color: 'var(--fg)',
  textDecoration: 'none',
  transition: 'background 100ms',
};

export interface StreamsTableProps {
  readonly streams: Stream[];
}

export function StreamsTable({ streams }: StreamsTableProps) {
  if (streams.length === 0) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <ListOrdered size={28} style={{ color: 'var(--fg-5)', margin: '0 auto 8px' }} />
        <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--fg-3)' }}>
          No streams found
        </p>
        <p style={{ marginTop: 4, fontSize: 11.5, color: 'var(--fg-4)' }}>
          Adjust your filters, or create a new stream.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Header row */}
      <div
        style={{
          ...rowStyle,
          padding: '10px 18px',
          background: 'var(--card-2)',
          borderBottom: '1px solid var(--line-2)',
          fontSize: 10.5,
          fontWeight: 500,
          color: 'var(--fg-4)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        <div>Stream id / parties</div>
        <div>Progress</div>
        <div>Amount</div>
        <div>Settlement</div>
        <div>Status</div>
        <div />
      </div>

      {streams.map((stream, i) => (
        <StreamRow key={stream.config.streamId} stream={stream} isLast={i === streams.length - 1} />
      ))}
    </div>
  );
}

function StreamRow({ stream, isLast }: { readonly stream: Stream; readonly isLast: boolean }) {
  const dep = Number(stream.config.totalDeposited.toString());
  const wd = Number(stream.state.totalWithdrawn.toString());
  const pct = dep > 0 ? Math.min(1, wd / dep) : 0;
  const settlementLabel =
    SETTLEMENT_LABELS[stream.config.settlementMode ?? SettlementMode.TokenStandardCustody] ??
    'Unknown';
  const instrumentId = stream.config.instrumentRef?.instrumentId;
  const flowBarClass = stream.state.status === StreamStatus.Active ? 'flow-bar' : 'flow-bar static';

  return (
    <Link
      to={`/streams/${encodeURIComponent(stream.config.sender)}/${encodeURIComponent(stream.config.streamId)}`}
      style={{
        ...rowStyle,
        borderBottom: isLast ? 'none' : '1px solid var(--line)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>
            {stream.config.streamId.slice(0, 14)}…
          </span>
          <span className="badge muted" style={{ fontSize: 10 }}>
            {stream.config.vestingMode.mode}
          </span>
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 3 }}>
          {partyHint(stream.config.sender)} → {partyHint(stream.config.recipient)}
        </div>
      </div>

      <div style={{ minWidth: 0 }}>
        <div className={flowBarClass}>
          <div className="fill" style={{ width: `${pct * 100}%` }} />
        </div>
        <div
          className="mono"
          style={{
            fontSize: 10.5,
            color: 'var(--fg-4)',
            marginTop: 4,
          }}
        >
          {(pct * 100).toFixed(1)}%
        </div>
      </div>

      <div style={{ textAlign: 'right' }}>
        <div className="mono" style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
          {fmt(dep)}
        </div>
        {instrumentId && (
          <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)', marginTop: 2 }}>
            {instrumentId}
          </div>
        )}
      </div>

      <div>
        <span className="badge info" style={{ fontSize: 10.5 }}>
          {settlementLabel}
        </span>
      </div>

      <div>
        <StatusBadge status={stream.state.status} />
      </div>

      <ArrowUpRight size={14} style={{ color: 'var(--fg-4)' }} />
    </Link>
  );
}

function fmt(n: number, decimals = 2): string {
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
