/**
 * EscrowsPage — the person's Vault streams.
 *
 * A Vault stream is deposit-once, paid-out-on-a-schedule. The row leads with the
 * counterparty and amount (not internal ids), and shows how much has been paid.
 */

import { useMemo } from 'react';
import { Link } from 'react-router';
import { Lock, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { useEscrows } from '../hooks/useEscrows.js';
import { useAuth } from '../store/auth.js';
import { Skeleton, ErrorState, PageHeader } from '../components/common/index.js';
import { fmtAsset, assetOfView, displayName } from '../lib/format.js';
import type { EscrowView } from '../api/client.js';

const STATUS_LABEL: Record<EscrowView['status'], string> = {
  active: 'paying out',
  completed: 'completed',
  refunded: 'stopped',
};

export function EscrowsPage() {
  const { party } = useAuth();
  const escrowsQ = useEscrows();

  const rows = useMemo<EscrowView[]>(() => [...(escrowsQ.data ?? [])], [escrowsQ.data]);

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Vault streams"
        subtitle="Fund a stream once and it pays the recipient on schedule — no approvals per payment."
        actions={
          <Link to="/v1/escrows/create" className="btn btn-primary">
            <Lock size={14} /> New vault stream
          </Link>
        }
      />

      {escrowsQ.isPending && <Skeleton.Row count={4} height={64} />}

      {escrowsQ.isError && (
        <ErrorState error={escrowsQ.error} title="Could not load vault streams" onRetry={() => escrowsQ.refetch()} />
      )}

      {escrowsQ.data && rows.length === 0 && !escrowsQ.isPending && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <p style={{ margin: '0 0 14px', color: 'var(--fg-3)', fontSize: 13 }}>
            No vault streams yet.
          </p>
          <Link to="/v1/escrows/create" className="btn btn-primary" style={{ display: 'inline-flex' }}>
            <Lock size={14} /> Start one
          </Link>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((e, i) => (
            <EscrowRow key={e.escrowId} view={e} party={party} last={i === rows.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function EscrowRow({
  view,
  party,
  last,
}: {
  readonly view: EscrowView;
  readonly party: string | null;
  readonly last: boolean;
}) {
  const outgoing = party != null && view.originalPayer === party;
  const counterparty = outgoing ? view.recipient : view.originalPayer;
  const asset = assetOfView(view);
  const total = Number(view.summary.totalIn);
  const paid = Number(view.summary.totalStreamed);
  const pct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;

  return (
    <Link
      to={`/v1/escrows/${encodeURIComponent(view.escrowId)}`}
      title={view.escrowId}
      style={{
        display: 'grid',
        gridTemplateColumns: '1.6fr 1.4fr 1fr auto',
        alignItems: 'center',
        gap: 14,
        padding: '14px 18px',
        textDecoration: 'none',
        color: 'inherit',
        borderBottom: last ? 'none' : '1px solid var(--line)',
      }}
    >
      {/* Counterparty + direction */}
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        {outgoing ? (
          <ArrowUpRight size={15} style={{ color: 'var(--warn)', flexShrink: 0 }} />
        ) : (
          <ArrowDownLeft size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {outgoing ? 'To ' : 'From '}{displayName(counterparty)}
          </div>
          <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>{STATUS_LABEL[view.status]}</span>
        </div>
      </div>

      {/* Progress */}
      <div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--line-2)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: view.status === 'refunded' ? 'var(--fg-4)' : 'var(--accent)' }} />
        </div>
        <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-4)', marginTop: 5 }}>
          {fmtAsset(paid, asset)} of {fmtAsset(total, asset)} paid
        </span>
      </div>

      {/* Payments made */}
      <div>
        <span style={{ fontSize: 13, color: 'var(--fg)' }}>
          {fmtAsset(view.ratePerCycle, asset)}
        </span>
        <span style={{ display: 'block', fontSize: 10.5, color: 'var(--fg-4)', marginTop: 3 }}>
          {view.summary.cyclesDelivered} sent{view.summary.cyclesPending > 0 ? ` · ${view.summary.cyclesPending} pending` : ''}
        </span>
      </div>

      <ArrowUpRight size={14} style={{ color: 'var(--fg-4)' }} />
    </Link>
  );
}
