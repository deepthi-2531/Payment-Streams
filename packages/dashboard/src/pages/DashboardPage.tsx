/** Dashboard overview for wallet holdings, incoming streams, and active streams. */

import { Link } from 'react-router';
import { Plus, Inbox, ArrowUpRight, TrendingUp, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import { AssetGlyph } from '../components/primitives/AssetGlyph.js';
import { displayName, instrumentLabel } from '../lib/format.js';

export function DashboardPage() {
  const { party } = useAuth();
  const streamsQ = useStreams();
  // Incoming preview surfaces streams where this party is the recipient.
  const incomingQ = useStreams(party ? { recipient: party } : undefined);

  const streams = streamsQ.data;
  const pendingRequests = incomingQ.data;
  const holdingsQ = useWalletHoldings();
  const holdingsResult = holdingsQ.data;
  const holdings: readonly WalletHolding[] = holdingsResult?.holdings ?? [];
  const [showSmall, setShowSmall] = useState(false);
  // Hide dust/zero balances by default (keep CC always — it's the primary asset),
  // CC first then by descending value. A "small balance" is one whose total value
  // (unlocked + locked) is below SMALL_BALANCE; the toggle reveals them.
  const SMALL_BALANCE = 0.01;
  const num = (raw: string, decimals: number): number =>
    Number(formatWalletBalance(raw, decimals).replace(/,/g, '')) || 0;
  const totalValueOf = (h: WalletHolding): number =>
    num(h.unlockedBalance, h.decimals) + num(h.lockedBalance, h.decimals);
  const isSmall = (h: WalletHolding): boolean =>
    !h.isCantonCoin && totalValueOf(h) < SMALL_BALANCE;
  const sortedHoldings = [...holdings].sort((a, b) => {
    if (a.isCantonCoin !== b.isCantonCoin) return a.isCantonCoin ? -1 : 1;
    return totalValueOf(b) - totalValueOf(a);
  });
  const smallCount = sortedHoldings.filter(isSmall).length;
  const displayHoldings = showSmall ? sortedHoldings : sortedHoldings.filter((h) => !isSmall(h));
  const hasHoldings = sortedHoldings.length > 0;
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

      {/* Wallet holdings */}
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
      {hasHoldings && (
        <div style={{ marginTop: 8, marginBottom: 32 }}>
          <SectionHeader
            title="Your wallet"
            count={displayHoldings.length}
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
            {displayHoldings.map((h) => (
              <WalletAssetCard key={`${h.instrumentAdmin}:${h.instrumentId}`} holding={h} />
            ))}
          </div>
          {smallCount > 0 && (
            <button
              type="button"
              onClick={() => setShowSmall((s) => !s)}
              style={{
                marginTop: 10,
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--accent)',
                font: 'inherit',
              }}
            >
              {showSmall
                ? 'Hide small balances'
                : `Show ${smallCount} small balance${smallCount === 1 ? '' : 's'}`}
            </button>
          )}
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
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--fg-2)',
            letterSpacing: '0.04em',
          }}
        >
          {instrumentLabel(asset)}
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
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            From {displayName(sender)}
          </span>
          <span className="badge warn">
            <span className="badge-dot" />
            Pending
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 2 }}>
          Wants to send you a payment
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
  status,
  isLast,
}: {
  readonly sender: string;
  readonly streamId: string;
  readonly recipient: string;
  readonly totalDeposited: string;
  readonly totalWithdrawn: string;
  readonly asset: string;
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
          <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {displayName(sender)} → {displayName(recipient)}
          </span>
          <span className="badge muted" style={{ fontSize: 10, flexShrink: 0 }}>
            {instrumentLabel(asset)}
          </span>
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

/**
 * Format a wallet-neutral integer minor-unit balance for display.
 * Mirrors `formatLoopBalance` from lib/loopWallet but works on raw
 * (rawString, decimals) pairs so callers don't have to hold onto
 * the original adapter type.
 */
function formatWalletBalance(raw: string, decimals: number): string {
  if (!raw) return '0';
  const neg = raw.startsWith('-');
  const body = neg ? raw.slice(1) : raw;
  // Group the integer part with thousands separators so a large balance reads
  // as "9,535,143,306,033" rather than a bare digit run.
  const group = (s: string): string => {
    try {
      return BigInt(s || '0').toLocaleString('en-US');
    } catch {
      return s;
    }
  };
  // Already a decimal string (wallet handed us major units) — don't shift again.
  if (body.includes('.')) {
    const [i = '', f = ''] = body.split('.');
    const ft = f.replace(/0+$/, '');
    return `${neg ? '-' : ''}${ft ? `${group(i)}.${ft}` : group(i)}`;
  }
  if (decimals === 0) return `${neg ? '-' : ''}${group(body)}`;
  const padded = body.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${fracPart ? `${group(intPart)}.${fracPart}` : group(intPart)}`;
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
        <AssetGlyph asset={holding.symbol} size={22} />
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
