/**
 * EscrowDetailPage — one Vault stream.
 *
 * Leads with who's being paid and how much has gone out, in plain language. The
 * on-chain audit trail (payment history + reconciliation) is kept but tucked
 * behind a toggle so the default view stays simple.
 */

import { useState } from 'react';
import { useParams, Link } from 'react-router';
import { ArrowLeft, ShieldCheck, ExternalLink, ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useEscrow, useRefundEscrow, useReconcileEscrow } from '../hooks/useEscrows.js';
import { useAuth } from '../store/auth.js';
import { Skeleton, ErrorState, PageHeader } from '../components/common/index.js';
import { explorerUpdateUrl, isVerifiableUpdateId, explorerName } from '../lib/scanLink.js';
import { fmtAsset, assetOfView, displayName, fmtWhen, type DisplayAsset } from '../lib/format.js';
import type { EscrowView, EscrowLedgerEntry } from '../api/client.js';

const STATUS: Record<EscrowView['status'], { label: string; cls: string }> = {
  active: { label: 'Paying out', cls: 'accent' },
  completed: { label: 'Completed', cls: 'accent' },
  refunded: { label: 'Stopped', cls: '' },
};

export function EscrowDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const escrowQ = useEscrow(id);

  return (
    <div style={{ paddingTop: 28, maxWidth: 820 }}>
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
  const [error, setError] = useState<string | null>(null);

  const isPayer = party != null && view.originalPayer === party;
  const counterparty = isPayer ? view.recipient : view.originalPayer;
  const asset = assetOfView(view);
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
        title={`${isPayer ? 'To' : 'From'} ${displayName(counterparty)}`}
        subtitle={`${fmtAsset(view.ratePerCycle, asset)} every ${cadenceLabel(view.cadenceSeconds)}`}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`badge ${status.cls}`} style={{ fontSize: 12 }}>{status.label}</span>
            {isPayer && view.status === 'active' && (
              <button className="btn btn-ghost" disabled={refund.isPending} onClick={doRefund}>
                {refund.isPending ? 'Stopping…' : 'Stop & get refund'}
              </button>
            )}
          </div>
        }
      />

      {/* Money summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
        <Metric label="Funded" value={fmtAsset(s.totalIn, asset)} />
        <Metric label="Paid out" value={fmtAsset(s.totalDelivered, asset)} tone="good" />
        {Number(s.totalPending) > 0 && <Metric label="Awaiting acceptance" value={fmtAsset(s.totalPending, asset)} tone="warn" />}
        {Number(s.totalRefunded) > 0 && <Metric label="Returned to you" value={fmtAsset(s.totalRefunded, asset)} />}
        <Metric label="Still in vault" value={fmtAsset(s.remaining, asset)} />
      </div>

      {/* Progress */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--fg-4)', marginBottom: 8 }}>
          <span>{s.cyclesDelivered} payment{s.cyclesDelivered === 1 ? '' : 's'} sent{s.cyclesPending > 0 ? ` · ${s.cyclesPending} awaiting acceptance` : ''}</span>
          <span>{pct}% paid{view.status === 'active' ? ` · next ${fmtWhen(view.nextDueAt)}` : ''}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--line-2)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: view.status === 'refunded' ? 'var(--fg-4)' : 'var(--accent)' }} />
        </div>
      </div>

      {/* Who + how it's held */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <Row label={isPayer ? 'From (you)' : 'From'} value={displayName(view.originalPayer)} full={view.originalPayer} me={isPayer} />
        <Row label={isPayer ? 'To' : 'To (you)'} value={displayName(view.recipient)} full={view.recipient} me={party === view.recipient} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0 0', fontSize: 11.5, color: 'var(--fg-4)' }}>
          <ShieldCheck size={13} style={{ color: 'var(--accent)' }} /> Held by CC Streams (the operator) while the stream runs.
        </div>
      </div>

      {Number(s.totalRefundPending) > 0 && (
        <div className="card" style={{ padding: 10, marginBottom: 18, borderColor: 'var(--warn)', fontSize: 12, color: 'var(--warn)' }}>
          A refund of {fmtAsset(s.totalRefundPending, asset)} is on its way back to you — accept it in your wallet to receive it.
        </div>
      )}

      {error && (
        <div className="card" style={{ padding: 12, marginBottom: 18, borderColor: 'var(--warn)', fontSize: 12, color: 'var(--warn)' }}>
          {error}
        </div>
      )}

      {/* Payment history + verification, collapsed by default */}
      <PaymentHistory view={view} />
    </>
  );
}

function PaymentHistory({ view }: { view: EscrowView }) {
  const [open, setOpen] = useState(false);
  const reconQ = useReconcileEscrow(view.escrowId, open);
  const verified = reconQ.data ? reconQ.data.checks.every((c) => c.ok) : null;
  const asset = assetOfView(view);

  return (
    <div className="card" style={{ padding: 16 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--fg)' }}
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <span style={{ fontSize: 13.5, fontWeight: 500 }}>Payment history</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: verified === false ? 'var(--warn)' : 'var(--accent)' }}>
          <ShieldCheck size={13} /> {verified === false ? 'Check needed' : 'Operator-reported'}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          {view.ledger.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-4)' }}>No payments yet.</p>
          ) : (
            <div style={{ display: 'grid', gap: 2 }}>
              {view.ledger.map((l) => (
                <LedgerRow key={l.eventId} l={l} asset={asset} />
              ))}
            </div>
          )}
          {reconQ.data && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)', display: 'grid', gap: 5 }}>
              {reconQ.data.checks.map((c) => (
                <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--fg-4)' }}>
                  <span style={{ color: c.ok ? 'var(--accent)' : 'var(--warn)' }}>{c.ok ? '✓' : '✗'}</span>
                  {checkLabel(c.name)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LedgerRow({ l, asset }: { l: EscrowLedgerEntry; asset: DisplayAsset }) {
  const kind = l.kind === 'deposit' ? 'Funded' : l.kind === 'refund' ? 'Returned' : 'Payment';
  const delivered = l.delivery === 'direct' || l.offerStatus === 'accepted';
  const state =
    l.delivery === 'direct' ? 'sent'
      : l.offerStatus === 'accepted' ? 'received'
        : l.offerStatus === 'withdrawn' ? 'canceled'
          : l.offerStatus === 'expired' ? 'expired'
            : 'awaiting acceptance';
  const by = l.initiatedBy === 'streamer' ? 'Automatic' : l.initiatedBy === 'operator' ? 'Manual' : 'You';
  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: '84px 1fr auto 96px 64px', gap: 10, alignItems: 'center', padding: '9px 0', borderTop: '1px solid var(--line)', fontSize: 12.5 }}
    >
      <span style={{ color: 'var(--fg-3)' }}>{kind}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, color: 'var(--fg-2)' }}>
        <span title={l.from}>{displayName(l.from)}</span>
        <ArrowRight size={11} style={{ color: 'var(--fg-4)', flexShrink: 0 }} />
        <span title={l.to}>{displayName(l.to)}</span>
      </span>
      <span style={{ color: 'var(--fg)' }}>{fmtAsset(l.amount, asset)}</span>
      <span style={{ fontSize: 11, color: delivered ? 'var(--accent)' : l.delivery === 'pending_offer' ? 'var(--warn)' : 'var(--fg-3)' }} title={`${by} · ${fmtWhen(l.at)}`}>
        {state}
      </span>
      <span>
        {l.updateId && isVerifiableUpdateId(l.updateId) ? (
          <a href={explorerUpdateUrl(l.updateId)} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: 'var(--accent)', textDecoration: 'none' }} title={`View on ${explorerName()}`}>
            View <ExternalLink size={10} />
          </a>
        ) : <span style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>—</span>}
      </span>
    </div>
  );
}

function checkLabel(name: string): string {
  switch (name) {
    case 'chainReachable': return 'Confirmed against the network';
    case 'releasedMatchesOnLedger': return 'Paid-out total matches the network';
    case 'depositMatchesOnLedger': return 'Funded amount matches the network';
    case 'valueConservation': return 'Every coin accounted for';
    case 'escrowSolvency': return 'Vault holds what it owes';
    case 'operatorEscrowResolved': return 'On-chain record found';
    case 'pendingOffersTracked': return 'Pending payments tracked';
    default: return name;
  }
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }) {
  const color = tone === 'good' ? 'var(--accent)' : tone === 'warn' ? 'var(--warn)' : 'var(--fg)';
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-4)' }}>{label}</div>
      <div style={{ fontSize: 17, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Row({ label, value, full, me }: { label: string; value: string; full: string; me?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: 12.5 }}>
      <span style={{ color: 'var(--fg-4)' }}>{label}</span>
      <span style={{ color: 'var(--fg-2)' }} title={full}>
        {value} {me && <span className="badge" style={{ fontSize: 10, marginLeft: 4 }}>you</span>}
      </span>
    </div>
  );
}

function cadenceLabel(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? 'day' : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? 'hour' : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? 'minute' : `${seconds / 60} minutes`;
  return `${seconds}s`;
}
