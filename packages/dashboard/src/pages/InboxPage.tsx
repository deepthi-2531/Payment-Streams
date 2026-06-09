/** Incoming streams for the connected party. */

import { type CSSProperties } from 'react';
import { Link } from 'react-router';
import { Inbox as InboxIcon, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { useAuth } from '../store/auth.js';
import { useStreams } from '../hooks/useStreams.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
  SectionHeader,
} from '../components/common/index.js';
import { PartyChip } from '../components/primitives/PartyChip.js';
import { VestingBadge } from '../components/primitives/VestingBadge.js';
import { SettlementBadge } from '../components/primitives/SettlementBadge.js';
import { WalletApprovalControl } from '../components/streams/WalletApprovalControl.js';
import type { Stream } from '@canton-streams/sdk/browser';

export function InboxPage() {
  const { party, isAuthenticated } = useAuth();

  const incomingQ = useStreams(party ? { recipient: party } : undefined);

  if (!isAuthenticated) {
    return (
      <div style={{ paddingTop: 28 }}>
        <PageHeader title="Incoming" subtitle="Streams sent to you" />
        <div
          className="card"
          style={{ padding: 36, textAlign: 'center', color: 'var(--fg-3)' }}
        >
          Connect your party to view incoming streams.
        </div>
      </div>
    );
  }

  const incoming = incomingQ.data ?? [];
  const incomingCount = incoming.length;

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Incoming"
        subtitle="Streams where you are the recipient"
        actions={
          <Link to="/create" className="btn btn-primary">
            <ArrowUpRight size={14} /> New stream
          </Link>
        }
      />

      {incomingQ.isError && (
        <ErrorState
          error={incomingQ.error}
          title="Could not load incoming streams"
          onRetry={() => incomingQ.refetch()}
        />
      )}

      {incomingQ.isPending && <Skeleton.Row count={3} height={120} />}

      {!incomingQ.isPending && incomingCount === 0 && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <InboxIcon
            size={28}
            style={{ color: 'var(--fg-5)', margin: '0 auto 8px' }}
          />
          <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-3)' }}>
            No incoming streams yet. V2 funding approvals happen in the wallet.
          </p>
        </div>
      )}

      {incomingCount > 0 && (
        <>
          <SectionHeader title="Incoming streams" count={incomingCount} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {incoming.map((stream) => (
              <IncomingCard
                key={`${stream.config.sender}:${stream.config.streamId}`}
                stream={stream}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function IncomingCard({ stream }: { readonly stream: Stream }) {
  const { config } = stream;
  const sender = config.sender;

  return (
    <div className="card" style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <PartyChip identity={{ handle: sender.split('::')[0] ?? sender, party: sender }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              color: 'var(--fg-4)',
              marginBottom: 2,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <ArrowDownLeft size={11} /> From ·{' '}
            <span className="mono" style={{ color: 'var(--fg-3)' }}>
              {config.streamId}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: 'var(--fg)',
                letterSpacing: '-0.02em',
              }}
            >
              {config.totalDeposited.toString()}
            </span>
            {config.instrumentRef && (
              <span
                className="mono"
                style={{ fontSize: 12, color: 'var(--fg-3)' }}
              >
                {config.instrumentRef.instrumentId}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          <VestingBadge vesting={config.vestingMode.mode} />
          {config.settlementMode && (
            <SettlementBadge mode={config.settlementMode} />
          )}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid var(--line)',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>
          {config.startTime.toLocaleDateString()} → {config.endTime.toLocaleDateString()}
        </div>
        <Link
          to={`/streams/${encodeURIComponent(config.streamId)}`}
          className="btn btn-ghost btn-sm"
        >
          View details <ArrowUpRight size={11} />
        </Link>
      </div>

      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid var(--line)',
        }}
      >
        <WalletApprovalControl stream={stream} />
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 16,
};
