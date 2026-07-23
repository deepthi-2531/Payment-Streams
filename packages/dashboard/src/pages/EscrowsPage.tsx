/**
 * EscrowsPage — list of operator-custodied streams (GET /api/v1/escrows).
 *
 * Distinct from the direct-delivery V1 list: these are custodial (funds sit in
 * the operator escrow party mid-flight), so the row shows deposit progress
 * rather than a per-cycle settle control.
 */

import { useMemo } from 'react';
import { Link } from 'react-router';
import { Lock, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { useEscrows } from '../hooks/useEscrows.js';
import { useAuth } from '../store/auth.js';
import { partyShort } from '../components/primitives/PartyChip.js';
import { Skeleton, ErrorState, PageHeader } from '../components/common/index.js';
import type { EscrowView } from '../api/client.js';

const STATUS_LABEL: Record<EscrowView['status'], string> = {
  active: 'streaming',
  completed: 'completed',
  refunded: 'refunded',
};

export function EscrowsPage() {
  const { party } = useAuth();
  const escrowsQ = useEscrows();

  const rows = useMemo<EscrowView[]>(() => [...(escrowsQ.data ?? [])], [escrowsQ.data]);

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Custodied streams"
        subtitle="Deposit once; the operator streams it to the recipient. Custodial — funds sit in the operator escrow while streaming."
        actions={
          <Link to="/v1/escrows/create" className="btn btn-primary">
            <Lock size={14} /> New custodied stream
          </Link>
        }
      />

      {escrowsQ.isPending && <Skeleton.Row count={4} height={64} />}

      {escrowsQ.isError && (
        <ErrorState error={escrowsQ.error} title="Could not load custodied streams" onRetry={() => escrowsQ.refetch()} />
      )}

      {escrowsQ.data && rows.length === 0 && !escrowsQ.isPending && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <p style={{ margin: '0 0 14px', color: 'var(--fg-3)', fontSize: 13 }}>
            No custodied streams yet.
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
  const total = Number(view.totalDeposited);
  const released = Number(view.released);
  const pct = total > 0 ? Math.min(100, Math.round((released / total) * 100)) : 0;

  return (
    <Link
      to={`/v1/escrows/${encodeURIComponent(view.escrowId)}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '1.4fr 1.6fr 1.3fr 1fr auto',
        alignItems: 'center',
        gap: 14,
        padding: '14px 18px',
        textDecoration: 'none',
        color: 'inherit',
        borderBottom: last ? 'none' : '1px solid var(--line)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {outgoing ? (
            <ArrowUpRight size={13} style={{ color: 'var(--warn)' }} />
          ) : (
            <ArrowDownLeft size={13} style={{ color: 'var(--accent)' }} />
          )}
          <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={view.escrowId}>
            {view.escrowId}
          </span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>custodial · {STATUS_LABEL[view.status]}</span>
      </div>

      <div style={{ minWidth: 0 }}>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          {outgoing ? 'to ' : 'from '}
          {counterparty.split('::')[0]}
        </span>
        <span className="mono" style={{ display: 'block', fontSize: 11, color: 'var(--fg-4)' }}>
          {partyShort(counterparty)}…
        </span>
      </div>

      {/* Progress */}
      <div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--line-2)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: view.status === 'refunded' ? 'var(--fg-4)' : 'var(--accent)' }} />
        </div>
        <span className="mono" style={{ display: 'block', fontSize: 11, color: 'var(--fg-4)', marginTop: 5 }}>
          {released} / {total} CC
        </span>
      </div>

      <div>
        <span className="badge accent" style={{ fontSize: 11 }}>
          {view.releases.length} {view.releases.length === 1 ? 'cycle' : 'cycles'}
        </span>
        <span style={{ display: 'block', fontSize: 10.5, color: 'var(--fg-4)', marginTop: 4 }}>
          {view.ratePerCycle} CC each
        </span>
      </div>

      <ArrowUpRight size={14} style={{ color: 'var(--fg-4)' }} />
    </Link>
  );
}
