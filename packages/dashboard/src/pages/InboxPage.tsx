/** Incoming streams + transfers for the connected party. */

import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import {
  Inbox as InboxIcon,
  ArrowDownLeft,
  ArrowUpRight,
  HandCoins,
  Loader2,
  CheckCircle2,
  Search,
  ChevronLeft,
  ChevronRight,
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
import { WalletApprovalControl } from '../components/streams/WalletApprovalControl.js';
import { fmtCc, fmtAmount, displayName, instrumentLabel } from '../lib/format.js';
import type { Stream } from '@canton-streams/sdk/browser';
import type { V1ReceivedPendingOffer, V1ReceivedTransfer } from '../api/client.js';

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

      {(incomingQ.isPending || receivedQ.isPending) && <Skeleton.Row count={3} height={120} />}

      {/* Incoming streams first — the recurring payments set up to you. */}
      {incomingCount > 0 && (
        <div style={{ marginBottom: 18 }}>
          <SectionHeader title="Incoming streams" count={incomingCount} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {incoming.map((stream) => (
              <IncomingCard
                key={`${stream.config.sender}:${stream.config.streamId}`}
                stream={stream}
              />
            ))}
          </div>
        </div>
      )}

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

      {received.length > 0 && <ReceivedSection received={received} />}

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
    </div>
  );
}

/**
 * The list of CC already delivered to this party. It grows without bound over
 * time, so it gets a text filter (match on amount or the on-chain id) and simple
 * paging. Newest first.
 */
const RECEIVED_PAGE_SIZE = 8;

function ReceivedSection({ received }: { readonly received: readonly V1ReceivedTransfer[] }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const sorted = useMemo(
    () => [...received].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
    [received],
  );
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? sorted.filter(
            (r) =>
              r.amount.toLowerCase().includes(q) || r.updateId.toLowerCase().includes(q),
          )
        : sorted,
    [sorted, q],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / RECEIVED_PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const start = clampedPage * RECEIVED_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + RECEIVED_PAGE_SIZE);

  return (
    <div style={{ marginBottom: 18 }}>
      <SectionHeader title="Received" count={received.length} />

      <div style={{ position: 'relative', marginBottom: 10, maxWidth: 320 }}>
        <Search
          size={13}
          style={{
            position: 'absolute',
            left: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--fg-4)',
            pointerEvents: 'none',
          }}
        />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="Filter by amount…"
          style={{
            width: '100%',
            background: 'var(--bg-elev)',
            border: '1px solid var(--line-2)',
            borderRadius: 'var(--r-sm)',
            padding: '7px 10px 7px 30px',
            fontSize: 12.5,
            color: 'var(--fg)',
            outline: 'none',
          }}
        />
      </div>

      {filtered.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--fg-4)', padding: '8px 2px' }}>
          No received transfers match “{query}”.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pageItems.map((r) => (
            <ReceivedTransferRow key={r.updateId} transfer={r} />
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
            marginTop: 12,
          }}
        >
          <span style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>
            Page {clampedPage + 1} of {pageCount}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={clampedPage === 0}
          >
            <ChevronLeft size={13} /> Prev
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={clampedPage >= pageCount - 1}
          >
            Next <ChevronRight size={13} />
          </button>
        </div>
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
          <div style={{ fontSize: 12, color: 'var(--fg-4)', marginBottom: 2, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ArrowDownLeft size={11} /> From {displayName(sender)}
          </div>
          <div style={{ fontSize: 18, fontWeight: 500, color: 'var(--fg)' }}>
            {fmtAmount(config.totalDeposited.toString())} {config.instrumentRef ? instrumentLabel(config.instrumentRef.instrumentId) : 'CC'}
          </div>
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
          <div style={{ fontSize: 12, color: 'var(--fg-4)', marginBottom: 2, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ArrowDownLeft size={11} /> {displayName(sender)} wants to send you
          </div>
          <div style={{ fontSize: 18, fontWeight: 500, color: 'var(--fg)' }}>
            {fmtCc(offer.amount)}
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
      <span style={{ fontSize: 15, fontWeight: 500, color: 'var(--fg)' }}>
        {fmtCc(transfer.amount)}
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
