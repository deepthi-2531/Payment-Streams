/**
 * StreamsTable — card-wrapped stream list.
 *
 * One row per stream: who's paying whom, progress, amount, and status.
 * The stream id and internal settlement mode live on the detail page, not here.
 */

import { Link } from 'react-router';
import { ArrowUpRight, ListOrdered } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Stream } from '@canton-streams/sdk/browser';
import { StreamStatus } from '@canton-streams/sdk/browser';
import { StatusBadge } from '../common/StatusBadge.js';
import { fmtAmount, displayName, instrumentLabel } from '../../lib/format.js';

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.6fr 1fr 150px 110px auto',
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
        <div>Payment</div>
        <div>Progress</div>
        <div style={{ textAlign: 'right' }}>Amount</div>
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
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {displayName(stream.config.sender)} → {displayName(stream.config.recipient)}
        </div>
      </div>

      <div style={{ minWidth: 0 }}>
        <div className={flowBarClass}>
          <div className="fill" style={{ width: `${pct * 100}%` }} />
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--fg-4)', marginTop: 4 }}>
          {(pct * 100).toFixed(0)}% paid
        </div>
      </div>

      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
          {fmtAmount(dep)}
        </div>
        {instrumentId && (
          <div style={{ fontSize: 10.5, color: 'var(--fg-4)', marginTop: 2 }}>
            {instrumentLabel(instrumentId)}
          </div>
        )}
      </div>

      <div>
        <StatusBadge status={stream.state.status} />
      </div>

      <ArrowUpRight size={14} style={{ color: 'var(--fg-4)' }} />
    </Link>
  );
}
