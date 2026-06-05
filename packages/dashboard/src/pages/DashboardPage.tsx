/**
 * DashboardPage — STR-116 Phase 5 reskin to cc-streams aesthetic.
 *
 * Layout adapted from the mock's dashboard.jsx:
 *   - Greeting header with active count + inflow/outflow rate
 *   - Asset breakdown cards (one per asset with positive flow)
 *   - "Awaiting your acceptance" inbox preview when pending != 0
 *   - "Streaming now" list of active streams (first 6)
 *
 * Data wiring unchanged: `useStreams` + `usePendingStreamRequests`
 * TanStack hooks against the proxy. Mutations / live ticker remain
 * as separate concerns (Phase 6 wizard + Phase 7 wallet).
 */

import { Link } from 'react-router';
import { Plus, Inbox, ArrowUpRight, TrendingUp, Wallet } from 'lucide-react';
import { useMemo } from 'react';
import { useStreams } from '../hooks/useStreams.js';
import { useWalletHoldings } from '../hooks/useWalletHoldings.js';
import { useAuth } from '../store/auth.js';
import { StreamStatus } from '@canton-streams/sdk/browser';
import {
  Skeleton,
  ErrorState,
  PageHeader,
  SectionHeader,
  StatusBadge,
} from '../components/common/index.js';
import type { WalletHolding } from '../lib/walletHoldings.js';
// Phase 7 (STR-118): AuthGate in App.tsx renders ConnectFlow when the
// user is unauthenticated, so DashboardPage no longer needs an unauth
// branch — it's only mounted once we have a session.

export function DashboardPage() {
  const { party } = useAuth();
  const streamsQ = useStreams();
  // "Inbox preview" surfaces streams where this party is the recipient.
  // The dashboard does not run a propose/accept ceremony today (V2
  // funding approval happens in the wallet), so showing
  // `usePendingStreamRequests()` here always rendered zero and
  // implied a non-existent acceptance step. Switched to active streams
  // filtered by recipient.
  const incomingQ = useStreams(party ? { recipient: party } : undefined);

  const streams = streamsQ.data;
  const pendingRequests = incomingQ.data;
  // Generic wallet holdings — works for every adapter PartyLayer
  // exposes (Loop via its REST API, Send/Nightly/Console via
  // canonical CIP-103 ACS, Cantor8/Bron return an empty list with
  // a `reason` we can surface to the user). The hook is wallet-
  // neutral; per-wallet logic lives in lib/walletAdapters.
  const holdingsQ = useWalletHoldings();
  const holdingsResult = holdingsQ.data;
  const holdings: readonly WalletHolding[] = holdingsResult?.holdings ?? [];
  const hasHoldings = holdings.length > 0;
  const unsupportedReason =
    holdingsResult?.strategy === 'unsupported' ? holdingsResult.reason : null;

  // Aggregate by asset for the asset cards.
  const byAsset = useMemo(() => {
    const out: Record<
      string,
      { count: number; outgoingRemaining: number; incomingRemaining: number }
    > = {};
    if (!streams) return out;
    for (const s of streams) {
      if (s.state.status !== StreamStatus.Active) continue;
      const asset = s.config.instrumentRef?.instrumentId ?? 'numeric';
      if (!out[asset]) {
        out[asset] = { count: 0, outgoingRemaining: 0, incomingRemaining: 0 };
      }
      out[asset].count++;
      const remaining = Number(
        s.config.totalDeposited.toString(),
      ) - Number(s.state.totalWithdrawn.toString());
      // Direction: caller's perspective. If `party` is the sender it's outgoing.
      if (party && s.config.sender === party) {
        out[asset].outgoingRemaining += remaining;
      } else {
        out[asset].incomingRemaining += remaining;
      }
    }
    return out;
  }, [streams, party]);

  const activeStreams = streams?.filter((s) => s.state.status === StreamStatus.Active) ?? [];
  const partyHint = party?.split('::')[0] ?? 'there';
  const pendingCount = pendingRequests?.length ?? 0;

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title={`Hello, ${partyHint}.`}
        subtitle={
          <span>
            {activeStreams.length} active stream{activeStreams.length === 1 ? '' : 's'}
            {' · '}
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              {streams?.length ?? 0} total
            </span>
          </span>
        }
        actions={
          <>
            <Link to="/inbox" className="btn btn-secondary">
              <Inbox size={14} /> Inbox
              {pendingCount > 0 && (
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    background: 'var(--warn-soft)',
                    color: 'var(--warn)',
                    padding: '1px 6px',
                    borderRadius: 999,
                    marginLeft: 4,
                  }}
                >
                  {pendingCount}
                </span>
              )}
            </Link>
            <Link to="/create" className="btn btn-primary">
              <Plus size={14} /> New stream
            </Link>
          </>
        }
      />

      {/* Wallet panel — generic across PartyLayer adapters.
          Loop → REST. Send/Nightly/Console → canonical CIP-103
          ACS via ledgerApi. Cantor8/Bron → empty + reason hint. */}
      {unsupportedReason && (
        <div
          className="card"
          style={{
            marginTop: 8,
            marginBottom: 32,
            padding: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'var(--fg-2)',
          }}
        >
          <Wallet size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontSize: 12 }}>{unsupportedReason}</span>
        </div>
      )}
      {hasHoldings && holdings && (
        <div style={{ marginTop: 8, marginBottom: 32 }}>
          <SectionHeader
            title="Your wallet"
            count={holdings.length}
            action={
              <Link to="/create" className="btn btn-ghost btn-sm">
                Stream an asset <ArrowUpRight size={12} />
              </Link>
            }
          />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {holdings.map((h) => (
              <WalletAssetCard key={`${h.instrumentAdmin}:${h.instrumentId}`} holding={h} />
            ))}
          </div>
        </div>
      )}
      {holdingsQ.isError && (
        <div style={{ marginTop: 8, marginBottom: 32 }}>
          <ErrorState
            error={holdingsQ.error}
            title="Could not load wallet holdings"
            onRetry={() => holdingsQ.refetch()}
          />
        </div>
      )}

      {/* Asset breakdown cards */}
      {streamsQ.isPending && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
            marginBottom: 32,
          }}
        >
          <Skeleton.Card />
          <Skeleton.Card />
          <Skeleton.Card />
        </div>
      )}

      {streamsQ.isError && (
        <ErrorState
          error={streamsQ.error}
          title="Could not load streams"
          onRetry={() => streamsQ.refetch()}
        />
      )}

      {streams && Object.keys(byAsset).length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
            marginBottom: 32,
          }}
        >
          {Object.entries(byAsset).map(([asset, data]) => (
            <AssetCard key={asset} asset={asset} data={data} />
          ))}
        </div>
      )}

      {/* Inbox preview */}
      {pendingCount > 0 && pendingRequests && (
        <div style={{ marginTop: 8, marginBottom: 32 }}>
          <SectionHeader
            title="Incoming streams"
            count={pendingCount}
            action={
              <Link to="/inbox" className="btn btn-ghost btn-sm">
                View all <ArrowUpRight size={12} />
              </Link>
            }
          />
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {pendingRequests.slice(0, 3).map((p, i) => (
              <PendingRow
                key={`${p.config.sender}:${p.config.streamId}`}
                sender={p.config.sender}
                streamId={p.config.streamId}
                isLast={i === Math.min(2, pendingRequests.length - 1)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Active streams list */}
      <div style={{ marginTop: 8 }}>
        <SectionHeader
          title="Streaming now"
          count={activeStreams.length}
          action={
            <Link to="/streams" className="btn btn-ghost btn-sm">
              All streams <ArrowUpRight size={12} />
            </Link>
          }
        />

        {streamsQ.isPending && <Skeleton.Row count={3} height={56} />}

        {streams && activeStreams.length === 0 && !streamsQ.isPending && (
          <div className="card" style={{ padding: 36, textAlign: 'center' }}>
            <TrendingUp
              size={28}
              style={{ color: 'var(--fg-5)', margin: '0 auto 8px' }}
            />
            <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-3)' }}>
              No active streams yet.
            </p>
            <Link
              to="/create"
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 12 }}
            >
              <Plus size={12} /> Create your first stream
            </Link>
          </div>
        )}

        {activeStreams.length > 0 && (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {activeStreams.slice(0, 6).map((s, i) => (
              <StreamRow
                key={s.config.streamId}
                sender={s.config.sender}
                streamId={s.config.streamId}
                recipient={s.config.recipient}
                totalDeposited={s.config.totalDeposited.toString()}
                totalWithdrawn={s.state.totalWithdrawn.toString()}
                asset={s.config.instrumentRef?.instrumentId ?? 'numeric'}
                vestingMode={s.config.vestingMode.mode}
                status={s.state.status}
                isLast={i === Math.min(5, activeStreams.length - 1)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local components — AssetCard, PendingRow, StreamRow
// ---------------------------------------------------------------------------

function AssetCard({
  asset,
  data,
}: {
  readonly asset: string;
  readonly data: { count: number; outgoingRemaining: number; incomingRemaining: number };
}) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--fg-2)',
            letterSpacing: '0.04em',
          }}
        >
          {asset}
        </span>
        <span className="badge accent">
          <span className="badge-dot" />
          {data.count} active
        </span>
      </div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 500, color: 'var(--fg)' }}>
        {fmt(data.outgoingRemaining + data.incomingRemaining)}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-4)', display: 'flex', gap: 12 }}>
        {data.outgoingRemaining > 0 && (
          <span>↑ out {fmt(data.outgoingRemaining)}</span>
        )}
        {data.incomingRemaining > 0 && (
          <span style={{ color: 'var(--accent)' }}>↓ in {fmt(data.incomingRemaining)}</span>
        )}
      </div>
    </div>
  );
}

function PendingRow({
  sender,
  streamId,
  isLast,
}: {
  readonly sender: string;
  readonly streamId: string;
  readonly isLast: boolean;
}) {
  return (
    <Link
      to={`/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 18px',
        borderBottom: isLast ? 'none' : '1px solid var(--line)',
        color: 'var(--fg)',
        textDecoration: 'none',
        transition: 'background 100ms',
      }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
            {streamId.slice(0, 18)}…
          </span>
          <span className="badge warn">
            <span className="badge-dot" />
            Pending
          </span>
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 2 }}>
          from {partyShort(sender)}
        </div>
      </div>
      <ArrowUpRight size={14} style={{ color: 'var(--fg-4)' }} />
    </Link>
  );
}

function StreamRow({
  sender,
  streamId,
  recipient,
  totalDeposited,
  totalWithdrawn,
  asset,
  vestingMode,
  status,
  isLast,
}: {
  readonly sender: string;
  readonly streamId: string;
  readonly recipient: string;
  readonly totalDeposited: string;
  readonly totalWithdrawn: string;
  readonly asset: string;
  readonly vestingMode: string;
  readonly status: StreamStatus;
  readonly isLast: boolean;
}) {
  const dep = Number(totalDeposited);
  const wd = Number(totalWithdrawn);
  const pct = dep > 0 ? Math.min(1, wd / dep) : 0;

  return (
    <Link
      to={`/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 200px auto',
        gap: 16,
        alignItems: 'center',
        padding: '14px 18px',
        borderBottom: isLast ? 'none' : '1px solid var(--line)',
        color: 'var(--fg)',
        textDecoration: 'none',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
            {streamId.slice(0, 12)}…
          </span>
          <span className="badge muted" style={{ fontSize: 10 }}>
            {vestingMode}
          </span>
          <span className="badge muted" style={{ fontSize: 10 }}>
            {asset}
          </span>
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 2 }}>
          {partyShort(sender)} → {partyShort(recipient)}
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="flow-bar">
          <div className="fill" style={{ width: `${pct * 100}%` }} />
        </div>
        <div
          className="mono"
          style={{
            fontSize: 10.5,
            color: 'var(--fg-4)',
            marginTop: 4,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>{fmt(wd)}</span>
          <span>/ {fmt(dep)}</span>
        </div>
      </div>
      <StatusBadge status={status} />
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

function partyShort(p: string): string {
  const sep = p.indexOf('::');
  return sep > 0 ? p.slice(0, Math.min(sep, 16)) : p.slice(0, 16);
}

/**
 * Format a wallet-neutral integer minor-unit balance for display.
 * Mirrors `formatLoopBalance` from lib/loopWallet but works on raw
 * (rawString, decimals) pairs so callers don't have to hold onto
 * the original adapter type.
 */
function formatWalletBalance(raw: string, decimals: number): string {
  if (!raw) return '0';
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function WalletAssetCard({ holding }: { holding: WalletHolding }) {
  const unlocked = formatWalletBalance(holding.unlockedBalance, holding.decimals);
  const locked = formatWalletBalance(holding.lockedBalance, holding.decimals);
  return (
    <Link
      to={`/create?asset=${encodeURIComponent(holding.instrumentId)}&admin=${encodeURIComponent(holding.instrumentAdmin)}`}
      className="card"
      style={{
        textDecoration: 'none',
        color: 'inherit',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Wallet size={14} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>{holding.symbol}</strong>
        {holding.isCantonCoin && (
          <span
            className="mono"
            style={{
              fontSize: 9,
              fontWeight: 600,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              padding: '1px 6px',
              borderRadius: 999,
            }}
          >
            CC
          </span>
        )}
      </div>
      <div
        className="mono"
        style={{ fontSize: 18, fontWeight: 600, lineHeight: 1 }}
        title={`Unlocked balance: ${unlocked}`}
      >
        {unlocked}
      </div>
      {locked !== '0' && (
        <div
          className="mono"
          style={{ fontSize: 11, color: 'var(--fg-3)' }}
          title={`Locked balance: ${locked}`}
        >
          + {locked} locked
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--fg-3)' }} title={holding.instrumentAdmin}>
        {holding.issuerName}
      </div>
    </Link>
  );
}
