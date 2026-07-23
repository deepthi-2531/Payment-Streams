/**
 * EscrowDetailPage — one operator-custodied stream (GET /api/v1/escrows/:id).
 *
 * Shows deposit → release progress, the parties (including the operator escrow
 * that holds the funds), each released cycle with its on-chain proof, and the
 * payer's stop/refund control. Custodial disclosure is kept visible.
 */

import { useState } from 'react';
import { useParams, Link } from 'react-router';
import { Lock, ArrowLeft, ShieldAlert, ExternalLink } from 'lucide-react';
import { useEscrow, useRefundEscrow, useEscrowInfo } from '../hooks/useEscrows.js';
import { useAuth } from '../store/auth.js';
import { partyShort } from '../components/primitives/PartyChip.js';
import { Skeleton, ErrorState, PageHeader } from '../components/common/index.js';
import { explorerUpdateUrl, isVerifiableUpdateId, explorerName } from '../lib/scanLink.js';
import type { EscrowView } from '../api/client.js';

const STATUS: Record<EscrowView['status'], { label: string; cls: string }> = {
  active: { label: 'Streaming', cls: 'accent' },
  completed: { label: 'Completed', cls: 'accent' },
  refunded: { label: 'Refunded', cls: '' },
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
        <ArrowLeft size={13} /> Custodied streams
      </Link>

      {escrowQ.isPending && <Skeleton.Card />}
      {escrowQ.isError && (
        <ErrorState error={escrowQ.error} title="Could not load this custodied stream" onRetry={() => escrowQ.refetch()} />
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
  const total = Number(view.totalDeposited);
  const released = Number(view.released);
  const remaining = Math.max(0, total - released);
  const pct = total > 0 ? Math.min(100, Math.round((released / total) * 100)) : 0;
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
        title="Custodied stream"
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

      {/* Custody disclosure */}
      <div className="card" style={{ padding: 13, marginBottom: 18, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <ShieldAlert size={16} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.5 }}>
          Custodial stream — the deposit sits in the operator escrow party while it streams. The payer
          can stop it any time and the unspent balance is refunded.
        </div>
      </div>

      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
        <Metric label="Deposited" value={`${fmtCC(view.totalDeposited)}`} />
        <Metric label="Released" value={`${fmtCC(view.released)}`} accent />
        <Metric label="Remaining" value={`${remaining.toFixed(4)} CC`} />
        <Metric label="Cycles" value={String(view.releases.length)} />
      </div>

      {/* Progress */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--fg-4)', marginBottom: 8 }}>
          <span>{view.ratePerCycle} CC every {cadenceLabel(view.cadenceSeconds)}</span>
          <span>{pct}% streamed{view.status === 'active' ? ` · next ${fmt(view.nextDueAt)}` : ''}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--line-2)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: view.status === 'refunded' ? 'var(--fg-4)' : 'var(--accent)' }} />
        </div>
      </div>

      {/* Parties */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <SectionTitle>Parties</SectionTitle>
        <Row label="Payer" value={view.originalPayer} me={isPayer} />
        <Row label="Recipient" value={view.recipient} me={party === view.recipient} />
        {infoQ.data && <Row label="Operator escrow (custodian)" value={infoQ.data.escrowParty} />}
      </div>

      {/* Funding deposit */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <SectionTitle>Funding deposit</SectionTitle>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
          <span style={{ color: 'var(--fg-3)' }}>{fmtCC(view.totalDeposited)} deposited into escrow</span>
          <ScanLink updateId={view.fundingTransferId} />
        </div>
      </div>

      {error && (
        <div className="card" style={{ padding: 12, marginBottom: 18, borderColor: 'var(--warn)', fontSize: 12, color: 'var(--warn)' }}>
          {error}
        </div>
      )}

      {/* Releases */}
      <div className="card" style={{ padding: 16 }}>
        <SectionTitle>Released cycles</SectionTitle>
        {view.releases.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-4)' }}>
            No cycles released yet — the streamer releases the first cycle shortly after the deposit settles.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {view.releases.map((r, i) => (
              <div
                key={r.updateId + i}
                style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: i === view.releases.length - 1 ? 'none' : '1px solid var(--line)' }}
              >
                <span className="badge accent" style={{ fontSize: 10.5 }}>#{i + 1}</span>
                <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg)' }}>{fmtCC(r.amount)}</span>
                <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>
                  {r.pending ? 'offer sent' : 'delivered'} · {fmt(r.at)}
                </span>
                <ScanLink updateId={r.updateId} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// --- small presentational helpers (mirrors V1StreamDetailPage conventions) ---

function ScanLink({ updateId }: { updateId: string }) {
  if (!isVerifiableUpdateId(updateId)) {
    return <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>(unverified)</span>;
  }
  return (
    <a
      href={explorerUpdateUrl(updateId)}
      target="_blank"
      rel="noreferrer"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}
    >
      {explorerName()} <ExternalLink size={11} />
    </a>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-4)' }}>{label}</div>
      <div className="mono" style={{ fontSize: 17, color: accent ? 'var(--accent)' : 'var(--fg)', marginTop: 4 }}>{value}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-4)', marginBottom: 12 }}>
      <Lock size={11} /> {children}
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
