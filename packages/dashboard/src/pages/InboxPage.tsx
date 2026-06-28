/** Incoming streams for the connected party. */

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
import { useStreams, useStreamsV1, useAcceptTransferV1 } from '../hooks/useStreams.js';
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
import type { V1StreamView, V1PendingTransferRecord } from '../api/client.js';

interface V1Offer {
  readonly view: V1StreamView;
  readonly offer: V1PendingTransferRecord;
}

export function InboxPage() {
  const { party, isAuthenticated } = useAuth();

  const incomingQ = useStreams(party ? { recipient: party } : undefined);
  // V1 pending offers (TransferInstructions awaiting this party's acceptance)
  // never appear in the V2 `useStreams` feed, so surface them here too — this is
  // where a recipient looks for "money sent to me". Only OPEN, non-expired offers
  // where this party is the recipient are actionable.
  const v1Q = useStreamsV1();
  const nowMs = Date.now();
  const myV1 = (v1Q.data ?? []).filter((v) => v.agreement.recipientParty === party);
  const v1Offers: readonly V1Offer[] = myV1.flatMap((view) =>
    (view.state.pendingTransfers ?? [])
      .filter((p) => p.status === 'pending' && Date.parse(p.executeBefore) > nowMs)
      .map((offer) => ({ view, offer })),
  );
  // Offers this party already accepted — money has landed. Surface them so the
  // recipient gets a "received" confirmation instead of the card just vanishing.
  const v1Received: readonly V1Offer[] = myV1.flatMap((view) =>
    (view.state.pendingTransfers ?? [])
      .filter((p) => p.status === 'accepted')
      .map((offer) => ({ view, offer })),
  );

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

      {v1Offers.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <SectionHeader title="Offers awaiting your acceptance" count={v1Offers.length} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {v1Offers.map(({ view, offer }) => (
              <IncomingOfferCard
                key={offer.transferInstructionCid}
                view={view}
                offer={offer}
                recipientParty={party!}
              />
            ))}
          </div>
        </div>
      )}

      {v1Received.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <SectionHeader title="Received" count={v1Received.length} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {v1Received.map(({ view, offer }) => (
              <ReceivedRow key={offer.transferInstructionCid} view={view} offer={offer} />
            ))}
          </div>
        </div>
      )}

      {incomingQ.isError && (
        <ErrorState
          error={incomingQ.error}
          title="Could not load incoming streams"
          onRetry={() => incomingQ.refetch()}
        />
      )}

      {incomingQ.isPending && <Skeleton.Row count={3} height={120} />}

      {!incomingQ.isPending &&
        incomingCount === 0 &&
        v1Offers.length === 0 &&
        v1Received.length === 0 && (
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

function IncomingOfferCard({
  view,
  offer,
  recipientParty,
}: {
  readonly view: V1StreamView;
  readonly offer: V1PendingTransferRecord;
  readonly recipientParty: string;
}) {
  const accept = useAcceptTransferV1();
  const sender = view.agreement.payerParty;
  const expires = new Date(offer.executeBefore);

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
              {view.agreement.agreementId}
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
              CC
            </span>
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={() =>
            accept.mutate({
              id: view.agreement.agreementId,
              recipientParty,
              selector: { transferInstructionCid: offer.transferInstructionCid },
            })
          }
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
          accept before {expires.toLocaleString()}
        </div>
        <Link
          to={`/v1/streams/${encodeURIComponent(view.agreement.agreementId)}`}
          className="btn btn-ghost btn-sm"
        >
          View details <ArrowUpRight size={11} />
        </Link>
      </div>

      {accept.isError && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--danger, #e5484d)' }}>
          {accept.error instanceof Error ? accept.error.message : 'Accept failed'}
        </div>
      )}
    </div>
  );
}

function ReceivedRow({
  view,
  offer,
}: {
  readonly view: V1StreamView;
  readonly offer: V1PendingTransferRecord;
}) {
  const sender = view.agreement.payerParty;
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
      <span
        className="mono"
        style={{ fontSize: 15, fontWeight: 500, color: 'var(--fg)' }}
      >
        {Number(offer.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} CC
      </span>
      <span style={{ fontSize: 12, color: 'var(--fg-4)' }}>
        received from{' '}
        <span className="mono" style={{ color: 'var(--fg-3)' }}>
          {sender.split('::')[0] ?? sender}
        </span>
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        {isVerifiableUpdateId(offer.finalUpdateId) && (
          <a
            href={explorerUpdateUrl(offer.finalUpdateId)}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}
            title={offer.finalUpdateId}
          >
            View on {explorerName()} ↗
          </a>
        )}
        <Link
          to={`/v1/streams/${encodeURIComponent(view.agreement.agreementId)}`}
          className="btn btn-ghost btn-sm"
        >
          Details <ArrowUpRight size={11} />
        </Link>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 16,
};
