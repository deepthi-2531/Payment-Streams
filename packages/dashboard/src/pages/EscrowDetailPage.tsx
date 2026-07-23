/**
 * EscrowDetailPage — one operator-custodied stream (GET /api/v1/escrows/:id).
 *
 * Custodial, so the audit view is first-class: an analytics strip that separates
 * streamed / delivered / pending / refunded, an append-only flow ledger of every
 * leg (from → to, on-chain anchor, who initiated it), and an on-demand
 * reconciliation against the chain (OperatorEscrow + balances + offer status).
 */

import { useParams, Link } from 'react-router';
import { Lock, ArrowLeft, ShieldAlert, ExternalLink, ArrowRight, Scale } from 'lucide-react';
import { useEscrow, useRefundEscrow, useEscrowInfo, useReconcileEscrow } from '../hooks/useEscrows.js';
import { useAuth } from '../store/auth.js';
import { useState } from 'react';
import { partyShort } from '../components/primitives/PartyChip.js';
import { Skeleton, ErrorState, PageHeader } from '../components/common/index.js';
import { explorerUpdateUrl, isVerifiableUpdateId } from '../lib/scanLink.js';
import type { EscrowView, EscrowLedgerEntry } from '../api/client.js';

const STATUS: Record<EscrowView['status'], { label: string; cls: string }> = {
  active: { label: 'Streaming', cls: 'accent' },
  completed: { label: 'Completed', cls: 'accent' },
  refunded: { label: 'Refunded', cls: '' },
};

export function EscrowDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const escrowQ = useEscrow(id);

  return (
    <div style={{ paddingTop: 28, maxWidth: 860 }}>
      <Link
        to="/v1/escrows"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--fg-3)', textDecoration: 'none', marginBottom: 12 }}
      >
        <ArrowLeft size={13} /> Vault streams
      </Link>

      {escrowQ.isPending && <Skeleton.Card />}
      {escrowQ.isError && (
        <ErrorState error={escrowQ.error} title="Could not load this vault stream" onRetry={() => escrowQ.refetch()} />
      )}
      {escrowQ.data && <EscrowDetail view={escrowQ.data} />}
    </div>
  );
}

function EscrowDetail({ view }: { view: EscrowView }) {
  const { party } = useAuth();
  const refund = useRefundEscrow();
  const infoQ = useEscrowInfo();
  const [error, setError] = useState<string | null>(null);

  const isPayer = party != null && view.originalPayer === party;
  const s = view.summary;
  const pct = Number(s.totalIn) > 0 ? Math.min(100, Math.round((Number(s.totalStreamed) / Number(s.totalIn)) * 100)) : 0;
  const status = STATUS[view.status];

  async function doRefund() {
    setError(null);
    try {
      await refund.mutateAsync({ id: view.escrowId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <PageHeader
        title="Vault stream"
        subtitle={view.escrowId}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`badge ${status.cls}`} style={{ fontSize: 12 }}>{status.label}</span>
            {isPayer && view.status === 'active' && (
              <button className="btn btn-ghost" disabled={refund.isPending} onClick={doRefund}>
                {refund.isPending ? 'Refunding…' : 'Stop & refund'}
              </button>
            )}
          </div>
        }
      />

      <div className="card" style={{ padding: 13, marginBottom: 18, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <ShieldAlert size={16} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.5 }}>
          Vault stream — your deposit is held in the operator vault (an escrow party) while it streams
          to the recipient (custodial). The payer can stop it any time and the unspent balance is refunded.
        </div>
      </div>

      {/* Analytics strip — streamed / delivered / pending / refunded / remaining. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 18 }}>
        <Metric label="Deposited" value={fmtCC(s.totalIn)} />
        <Metric label="Streamed" value={fmtCC(s.totalStreamed)} accent />
        <Metric label="Delivered" value={fmtCC(s.totalDelivered)} tone="good" />
        <Metric label="Pending" value={fmtCC(s.totalPending)} tone={Number(s.totalPending) > 0 ? 'warn' : undefined} />
        <Metric label="Refunded" value={fmtCC(s.totalRefunded)} />
        <Metric label="Remaining" value={fmtCC(s.remaining)} />
      </div>

      {Number(s.totalRefundPending) > 0 && (
        <div className="card" style={{ padding: 10, marginBottom: 18, borderColor: 'var(--warn)', fontSize: 12, color: 'var(--warn)' }}>
          Refund of {fmtCC(s.totalRefundPending)} left the vault but is awaiting the payer's acceptance
          (not yet in the payer's wallet).
        </div>
      )}

      {/* Progress */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--fg-4)', marginBottom: 8 }}>
          <span>{view.ratePerCycle} CC every {cadenceLabel(view.cadenceSeconds)} · {s.cyclesReleased} released ({s.cyclesDelivered} delivered / {s.cyclesPending} pending)</span>
          <span>{pct}% streamed{view.status === 'active' ? ` · next ${fmt(view.nextDueAt)}` : ''}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--line-2)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: view.status === 'refunded' ? 'var(--fg-4)' : 'var(--accent)' }} />
        </div>
      </div>

      {/* Parties */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <SectionTitle icon={<Lock size={11} />}>Parties</SectionTitle>
        <Row label="Payer (source)" value={view.originalPayer} me={isPayer} />
        <Row label="Recipient (destination)" value={view.recipient} me={party === view.recipient} />
        {infoQ.data && <Row label="Operator vault (custodian)" value={infoQ.data.escrowParty} />}
      </div>

      {error && (
        <div className="card" style={{ padding: 12, marginBottom: 18, borderColor: 'var(--warn)', fontSize: 12, color: 'var(--warn)' }}>
          {error}
        </div>
      )}

      {/* Flow ledger — append-only audit trail of every value leg. */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <SectionTitle icon={<Lock size={11} />}>Flow ledger</SectionTitle>
        {view.ledger.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-4)' }}>No legs recorded yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gap: 2, minWidth: 640 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '28px 90px 1fr 96px 120px 90px 60px', gap: 8, padding: '0 0 6px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-4)' }}>
                <span>#</span><span>Leg</span><span>From → To</span><span style={{ textAlign: 'right' }}>Amount</span><span>Delivery</span><span>By</span><span>Proof</span>
              </div>
              {view.ledger.map((l) => (
                <LedgerRow key={l.eventId} l={l} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Reconciliation against the chain. */}
      <ReconcileCard escrowId={view.escrowId} live={view.status === 'active'} />
    </>
  );
}

function LedgerRow({ l }: { l: EscrowLedgerEntry }) {
  const kindTone = l.kind === 'deposit' ? 'good' : l.kind === 'refund' ? 'warn' : 'accent';
  const delivered = l.delivery === 'direct' || l.offerStatus === 'accepted';
  const deliveryLabel = l.delivery === 'direct'
    ? 'delivered'
    : l.offerStatus === 'accepted'
      ? 'accepted'
      : l.offerStatus === 'withdrawn'
        ? 'withdrawn'
        : l.offerStatus === 'expired'
          ? 'expired'
          : 'offer pending';
  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: '28px 90px 1fr 96px 120px 90px 60px', gap: 8, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--line)', fontSize: 12 }}
      title={l.authorizationBasis ?? l.reasonCode ?? ''}
    >
      <span className="mono" style={{ color: 'var(--fg-4)', fontSize: 11 }}>{l.seq}</span>
      <span className={`badge ${kindTone === 'accent' ? 'accent' : ''}`} style={{ fontSize: 10.5, color: kindTone === 'good' ? 'var(--good, var(--accent))' : kindTone === 'warn' ? 'var(--warn)' : undefined }}>
        {l.direction === 'in' ? '↓ ' : '↑ '}{l.kind}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, color: 'var(--fg-2)' }}>
        <span title={l.from}>{l.from.split('::')[0]}</span>
        <ArrowRight size={11} style={{ color: 'var(--fg-4)', flexShrink: 0 }} />
        <span title={l.to}>{l.to.split('::')[0]}</span>
      </span>
      <span className="mono" style={{ textAlign: 'right', color: 'var(--fg)' }}>{Number(Number(l.amount).toFixed(10))}</span>
      <span style={{ fontSize: 11, color: delivered ? 'var(--good, var(--accent))' : l.delivery === 'pending_offer' ? 'var(--warn)' : 'var(--fg-3)' }}>
        {deliveryLabel}
      </span>
      <span style={{ fontSize: 11, color: 'var(--fg-4)' }} title={l.initiatedBy === 'streamer' ? 'automated release, no per-cycle signature' : ''}>
        {l.initiatedBy}
      </span>
      <span>{l.updateId && isVerifiableUpdateId(l.updateId) ? (
        <a href={explorerUpdateUrl(l.updateId)} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: 'var(--accent)', textDecoration: 'none' }}>
          Scan <ExternalLink size={10} />
        </a>
      ) : <span style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>—</span>}</span>
    </div>
  );
}

function ReconcileCard({ escrowId, live }: { escrowId: string; live: boolean }) {
  const reconQ = useReconcileEscrow(escrowId, true);
  const r = reconQ.data;
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <SectionTitle icon={<Scale size={11} />}>Reconciliation (off-ledger vs chain)</SectionTitle>
        <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => reconQ.refetch()} disabled={reconQ.isFetching}>
          {reconQ.isFetching ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      {reconQ.isPending && <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-4)' }}>Reconciling…</p>}
      {reconQ.isError && <p style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>Could not reconcile right now.</p>}
      {r && (
        <>
          <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
            {r.checks.map((c) => (
              <div key={c.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
                <span className="badge" style={{ fontSize: 10, color: c.ok ? 'var(--good, var(--accent))' : 'var(--warn)', flexShrink: 0 }}>
                  {c.ok ? '✓ ok' : '✗ break'}
                </span>
                <span style={{ color: 'var(--fg-3)' }}>{c.detail}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11.5, color: 'var(--fg-3)' }}>
            <span>On-ledger OperatorEscrow.released: <strong className="mono" style={{ color: 'var(--fg)' }}>{r.onLedger.operatorReleased ?? '—'}</strong></span>
            <span>Deposited: <strong className="mono" style={{ color: 'var(--fg)' }}>{r.onLedger.operatorTotalDeposited ?? '—'}</strong></span>
            <span title="Commingled — the escrow party may custody more than one escrow.">
              Escrow party balance: <strong className="mono" style={{ color: 'var(--fg)' }}>{Number(Number(r.onLedger.escrowFreeBalance).toFixed(4))} CC</strong> {r.onLedger.commingled && <span style={{ color: 'var(--fg-4)' }}>(commingled)</span>}
            </span>
            <span>Offers tracked: <strong style={{ color: 'var(--fg)' }}>{r.offers.length}</strong> ({r.offers.filter((o) => o.status === 'active').length} awaiting accept)</span>
          </div>
          {live && (
            <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--fg-4)' }}>
              Auto-re-checks every 15s while streaming — pending offers flip to delivered as the recipient accepts.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// --- small presentational helpers ---

function Metric({ label, value, accent, tone }: { label: string; value: string; accent?: boolean; tone?: 'good' | 'warn' }) {
  const color = tone === 'good' ? 'var(--good, var(--accent))' : tone === 'warn' ? 'var(--warn)' : accent ? 'var(--accent)' : 'var(--fg)';
  return (
    <div className="card" style={{ padding: '10px 12px' }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-4)' }}>{label}</div>
      <div className="mono" style={{ fontSize: 14, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function SectionTitle({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-4)' }}>
      {icon} {children}
    </div>
  );
}

function Row({ label, value, me }: { label: string; value: string; me?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: 12.5 }}>
      <span style={{ color: 'var(--fg-4)' }}>{label}</span>
      <span className="mono" style={{ color: 'var(--fg-2)' }} title={value}>
        {value.split('::')[0]}::{partyShort(value)}… {me && <span className="badge" style={{ fontSize: 10, marginLeft: 4 }}>you</span>}
      </span>
    </div>
  );
}

function fmtCC(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return `${raw} CC`;
  return `${Number(n.toFixed(10))} CC`;
}

function cadenceLabel(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? 'day' : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? 'hour' : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? 'minute' : `${seconds / 60} minutes`;
  return `${seconds}s`;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}
