/** Incoming streams + transfers for the connected party. */

import { type CSSProperties } from 'react';
import { Link } from 'react-router';
import {
  Inbox as InboxIcon,
  ArrowDownLeft,
  ArrowUpRight,
  HandCoins,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import { useAuth } from '../store/auth.js';
import { useStreams, useReceivedV1, useAcceptReceivedV1 } from '../hooks/useStreams.js';
import { explorerUpdateUrl, explorerName, isVerifiableUpdateId } from '../lib/scanLink.js';
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
import type { V1ReceivedPendingOffer, V1ReceivedTransfer } from '../api/client.js';

/** Amulet is Canton Coin — show the familiar ticker in the recipient view. */
function instrumentLabel(id: string): string {
  return id === 'Amulet' ? 'CC' : id;
}

export function InboxPage() {
  const { party, isAuthenticated } = useAuth();

  const incomingQ = useStreams(party ? { recipient: party } : undefined);
  // Ledger-backed incoming CC: pending offers this party must accept + CC
  // already delivered. Read straight from the participant, so it surfaces every
  // transfer to the party — including raw-registry and wallet-sent ones the
  // proxy store never tracked (which the V2 `useStreams` feed also cannot show).
  const receivedQ = useReceivedV1();
  const pending = receivedQ.data?.pending ?? [];
  const received = receivedQ.data?.received ?? [];

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
  const nothing =
    !incomingQ.isPending &&
    incomingCount === 0 &&
    pending.length === 0 &&
    received.length === 0;

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Incoming"
        subtitle="Streams and transfers where you are the recipient"
        actions={
          <Link to="/create" className="btn btn-primary">
            <ArrowUpRight size={14} /> New stream
          </Link>
        }
      />

      {pending.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <SectionHeader title="Offers awaiting your acceptance" count={pending.length} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pending.map((offer) => (
              <ReceivedOfferCard key={offer.transferInstructionCid} offer={offer} />
            ))}
          </div>
        </div>
      )}

      {received.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <SectionHeader title="Received" count={received.length} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {received.map((r) => (
              <ReceivedTransferRow key={r.updateId} transfer={r} />
            ))}
          </div>
        </div>
      )}

      {receivedQ.isError && (
        <ErrorState
          error={receivedQ.error}
          title="Could not load incoming transfers"
          onRetry={() => receivedQ.refetch()}
        />
      )}

      {incomingQ.isError && (
        <ErrorState
          error={incomingQ.error}
          title="Could not load incoming streams"
          onRetry={() => incomingQ.refetch()}
        />
      )}

      {(incomingQ.isPending || receivedQ.isPending) && <Skeleton.Row count={3} height={120} />}

      {nothing && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <InboxIcon
            size={28}
            style={{ color: 'var(--fg-5)', margin: '0 auto 8px' }}
          />
          <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-3)' }}>
            No incoming streams or transfers yet.
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

/** A pending incoming CC offer (AmuletTransferInstruction) the connected party
 * can accept. Read from the ledger, so it appears whether or not the transfer
 * was created through a proxy stream. */
function ReceivedOfferCard({ offer }: { readonly offer: V1ReceivedPendingOffer }) {
  const accept = useAcceptReceivedV1();
  const sender = offer.sender;

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
            <ArrowDownLeft size={11} /> Offer from ·{' '}
            <span className="mono" style={{ color: 'var(--fg-3)' }}>
              {sender.split('::')[0] ?? sender}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span
              className="mono"
              style={{ fontSize: 18, fontWeight: 500, color: 'var(--fg)', letterSpacing: '-0.02em' }}
            >
              {Number(offer.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </span>
            <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>
              {instrumentLabel(offer.instrumentId)}
            </span>
          </div>
        </div>
        {offer.expired ? (
          <span
            style={{
              minWidth: 104,
              textAlign: 'center',
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--fg-4)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              padding: '6px 10px',
            }}
          >
            Expired
          </span>
        ) : (
          <button
            className="btn btn-primary"
            onClick={() => accept.mutate(offer.transferInstructionCid)}
            disabled={accept.isPending || accept.isSuccess}
            style={{ minWidth: 104, justifyContent: 'center' }}
          >
            {accept.isPending ? (
              <Loader2 size={14} style={{ animation: 'spin 800ms linear infinite' }} />
            ) : accept.isSuccess ? (
              'Accepted'
            ) : (
              <>
                <HandCoins size={14} /> Accept
              </>
            )}
          </button>
        )}
      </div>

      {offer.executeBefore && (
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
          <div style={{ fontSize: 11.5, color: offer.expired ? 'var(--danger, #e5484d)' : 'var(--fg-4)' }}>
            {offer.expired ? 'expired ' : 'accept before '}
            {new Date(offer.executeBefore).toLocaleString()}
            {offer.expired && ' — ask the sender to re-send'}
          </div>
        </div>
      )}

      {accept.isError && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--danger, #e5484d)' }}>
          {accept.error instanceof Error ? accept.error.message : 'Accept failed'}
        </div>
      )}
    </div>
  );
}

/** A completed incoming transfer — CC that has landed in the party's wallet,
 * with its on-chain updateId linked to the explorer. */
function ReceivedTransferRow({ transfer }: { readonly transfer: V1ReceivedTransfer }) {
  return (
    <div
      className="card"
      style={{
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <CheckCircle2 size={16} style={{ color: 'var(--accent, #2e9e6b)', flexShrink: 0 }} />
      <span className="mono" style={{ fontSize: 15, fontWeight: 500, color: 'var(--fg)' }}>
        {Number(transfer.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} CC
      </span>
      <span style={{ fontSize: 12, color: 'var(--fg-4)' }}>
        received · {new Date(transfer.at).toLocaleString()}
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        {isVerifiableUpdateId(transfer.updateId) && (
          <a
            href={explorerUpdateUrl(transfer.updateId)}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}
            title={transfer.updateId}
          >
            View on {explorerName()} ↗
          </a>
        )}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 16,
};
