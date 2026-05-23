/**
 * InboxPage — STR-122 Phase 6.
 *
 * Two-tab inbox showing pending stream requests:
 *   - **Incoming**: requests where the connected party is the recipient,
 *     waiting for accept/reject (real `useWithdraw`/`useAcceptStream`)
 *   - **Outgoing**: requests this party authored as sender, waiting on
 *     the recipient to accept
 *
 * Both tabs hit the existing `usePendingStreamRequests({ recipient | sender })`
 * hook — no new API endpoint needed (the proxy already filters by party
 * role via `?sender=…` and `?recipient=…` query params; see
 * `api/client.ts::listPendingStreamRequests`). No mock fixtures.
 *
 * Accept/reject from the incoming tab opens the Phase 6 `AcceptModal`.
 */

import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { Inbox as InboxIcon, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { useAuth } from '../store/auth.js';
import { usePendingStreamRequests } from '../hooks/useStreams.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
  SectionHeader,
} from '../components/common/index.js';
import { PartyChip } from '../components/primitives/PartyChip.js';
import { VestingBadge } from '../components/primitives/VestingBadge.js';
import { SettlementBadge } from '../components/primitives/SettlementBadge.js';
import { AcceptModal } from '../components/streams/AcceptModal.js';
import type { PendingStreamRequest } from '@canton-streams/sdk/browser';

type Tab = 'in' | 'out';

export function InboxPage() {
  const { party, isAuthenticated } = useAuth();
  const [tab, setTab] = useState<Tab>('in');
  const [acceptTarget, setAcceptTarget] = useState<PendingStreamRequest | null>(null);

  // The proxy supports `?sender=` and `?recipient=` filters — we pass the
  // connected party in the appropriate slot for each tab.
  const incomingQ = usePendingStreamRequests(
    party ? { recipient: party } : undefined,
  );
  const outgoingQ = usePendingStreamRequests(party ? { sender: party } : undefined);

  if (!isAuthenticated) {
    return (
      <div style={{ paddingTop: 28 }}>
        <PageHeader title="Inbox" subtitle="Stream requests pending action" />
        <div
          className="card"
          style={{ padding: 36, textAlign: 'center', color: 'var(--fg-3)' }}
        >
          Connect your party to view the inbox.
        </div>
      </div>
    );
  }

  const active = tab === 'in' ? incomingQ : outgoingQ;
  const incomingCount = incomingQ.data?.length ?? 0;
  const outgoingCount = outgoingQ.data?.length ?? 0;

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Inbox"
        subtitle="Stream requests pending action"
        actions={
          <Link to="/create" className="btn btn-primary">
            <ArrowUpRight size={14} /> New stream
          </Link>
        }
      />

      {/* Tab strip */}
      <div
        style={{
          display: 'inline-flex',
          gap: 4,
          padding: 4,
          background: 'var(--bg-elev)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-md)',
          marginBottom: 18,
        }}
      >
        <TabButton
          active={tab === 'in'}
          onClick={() => setTab('in')}
          icon={<ArrowDownLeft size={13} />}
          label="Incoming"
          count={incomingCount}
        />
        <TabButton
          active={tab === 'out'}
          onClick={() => setTab('out')}
          icon={<ArrowUpRight size={13} />}
          label="Outgoing"
          count={outgoingCount}
        />
      </div>

      {active.isError && (
        <ErrorState
          error={active.error}
          title={`Could not load ${tab === 'in' ? 'incoming' : 'outgoing'} requests`}
          onRetry={() => active.refetch()}
        />
      )}

      {active.isPending && <Skeleton.Row count={3} height={120} />}

      {active.data && active.data.length === 0 && !active.isPending && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <InboxIcon
            size={28}
            style={{ color: 'var(--fg-5)', margin: '0 auto 8px' }}
          />
          <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-3)' }}>
            {tab === 'in'
              ? 'No incoming requests waiting on you.'
              : 'No outgoing requests waiting on recipients.'}
          </p>
        </div>
      )}

      {active.data && active.data.length > 0 && (
        <>
          <SectionHeader
            title={tab === 'in' ? 'Awaiting your acceptance' : 'Awaiting recipient'}
            count={active.data.length}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {active.data.map((req) => (
              <PendingCard
                key={`${req.config.sender}:${req.config.streamId}`}
                request={req}
                direction={tab}
                onAccept={tab === 'in' ? () => setAcceptTarget(req) : undefined}
              />
            ))}
          </div>
        </>
      )}

      {acceptTarget && (
        <AcceptModal
          request={acceptTarget}
          onClose={() => setAcceptTarget(null)}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 'var(--r-sm)',
        fontSize: 12.5,
        fontWeight: 500,
        color: active ? 'var(--accent)' : 'var(--fg-3)',
        background: active ? 'var(--accent-soft)' : 'transparent',
        transition: 'background 120ms, color 120ms',
      }}
    >
      {icon}
      {label}
      {count > 0 && (
        <span
          className="mono"
          style={{
            fontSize: 10,
            fontWeight: 600,
            background: active ? 'transparent' : 'var(--warn-soft)',
            color: active ? 'var(--accent)' : 'var(--warn)',
            padding: '1px 6px',
            borderRadius: 999,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function PendingCard({
  request,
  direction,
  onAccept,
}: {
  readonly request: PendingStreamRequest;
  readonly direction: Tab;
  readonly onAccept?: () => void;
}) {
  const { config } = request;
  const otherParty =
    direction === 'in' ? config.sender : config.recipient;

  return (
    <div className="card" style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <PartyChip identity={{ handle: otherParty.split('::')[0], party: otherParty }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              color: 'var(--fg-4)',
              marginBottom: 2,
            }}
          >
            {direction === 'in' ? 'From' : 'To'} ·{' '}
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
          {request.settlementMode && (
            <SettlementBadge mode={request.settlementMode} />
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
        }}
      >
        <div style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>
          {config.startTime.toLocaleDateString()} → {config.endTime.toLocaleDateString()}
        </div>
        {onAccept && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onAccept}
          >
            Review & accept
          </button>
        )}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 16,
};
