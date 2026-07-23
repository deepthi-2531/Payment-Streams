/**
 * CreateEscrowPage — start an operator-custodied stream.
 *
 * The payer funds the whole stream with ONE deposit into a dedicated
 * operator-controlled escrow party; the operator then releases to the recipient
 * on a schedule with no further payer signature. This is the "sign once" path
 * for wallets that cannot vet the canton-streams DAR — and it is custodial by
 * construction, so the custody disclosure is shown up front, not buried.
 */

import { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { Lock, ArrowLeft, ShieldAlert } from 'lucide-react';
import { useAuth } from '../store/auth.js';
import { useCreateEscrow, useEscrowInfo } from '../hooks/useEscrows.js';
import { useCantonCoinBalance } from '../hooks/useCantonCoinBalance.js';
import { partyShort } from '../components/primitives/PartyChip.js';
import { PageHeader } from '../components/common/index.js';

const CADENCES = [
  { label: 'Every minute', seconds: 60 },
  { label: 'Every hour', seconds: 3600 },
  { label: 'Every day', seconds: 86400 },
] as const;

export function CreateEscrowPage() {
  const { party } = useAuth();
  const navigate = useNavigate();
  const createEscrow = useCreateEscrow();
  const infoQ = useEscrowInfo();
  const cc = useCantonCoinBalance();

  const [recipient, setRecipient] = useState('');
  const [rate, setRate] = useState('1');
  const [cadenceSeconds, setCadenceSeconds] = useState<number>(86400);
  const [totalDeposit, setTotalDeposit] = useState('10');
  const [error, setError] = useState<string | null>(null);

  const rateNum = Number(rate);
  const depositNum = Number(totalDeposit);
  const cycles = rateNum > 0 ? Math.floor(depositNum / rateNum) : 0;
  const validRecipient = recipient.trim().includes('::');
  const canSubmit =
    validRecipient && rateNum > 0 && depositNum > 0 && depositNum >= rateNum && !createEscrow.isPending;

  async function submit() {
    setError(null);
    try {
      const escrow = await createEscrow.mutateAsync({
        recipient: recipient.trim(),
        ratePerCycle: String(rateNum),
        cadenceSeconds,
        totalDeposit: String(depositNum),
      });
      navigate(`/v1/escrows/${encodeURIComponent(escrow.escrowId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={{ paddingTop: 28, maxWidth: 720 }}>
      <Link
        to="/v1/escrows"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--fg-3)', textDecoration: 'none', marginBottom: 12 }}
      >
        <ArrowLeft size={13} /> Custodied streams
      </Link>

      <PageHeader
        title="New custodied stream"
        subtitle="Deposit once — the operator streams it to the recipient on schedule."
      />

      {/* Custody disclosure — shown before any input, not buried. */}
      <div
        className="card"
        style={{
          padding: 16,
          marginBottom: 20,
          borderColor: 'var(--warn)',
          background: 'color-mix(in srgb, var(--warn) 8%, var(--bg-elev))',
          display: 'flex',
          gap: 12,
        }}
      >
        <ShieldAlert size={18} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          <strong style={{ color: 'var(--fg)' }}>This is a custodial stream.</strong> Your full deposit
          moves into an operator-controlled escrow party up front, and the operator holds it while it
          streams to the recipient. You sign once. You can stop the stream and refund the unspent
          balance to yourself at any time. Prefer to keep custody? Use a{' '}
          <Link to="/v1/create" style={{ color: 'var(--accent)' }}>direct-delivery stream</Link>{' '}
          instead (you approve each cycle from your own wallet).
        </div>
      </div>

      <div className="card" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <Field label="Payer (you)">
          <div className="mono" style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            {party ? partyShort(party) + '…' : 'Not connected'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 3 }}>
            Wallet balance: {cc.isLoading ? '…' : `${cc.display ?? cc.value ?? '?'} CC`}
          </div>
        </Field>

        <Field label="Recipient party id">
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="party::1220…"
            className="mono"
            style={inputStyle}
          />
          {recipient.trim() && !validRecipient && (
            <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>
              Enter a full party id (contains "::").
            </div>
          )}
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Rate per cycle (CC)">
            <input value={rate} onChange={(e) => setRate(e.target.value)} type="number" min="0" step="0.01" style={inputStyle} />
          </Field>
          <Field label="Cadence">
            <select
              value={cadenceSeconds}
              onChange={(e) => setCadenceSeconds(Number(e.target.value))}
              style={inputStyle}
            >
              {CADENCES.map((c) => (
                <option key={c.seconds} value={c.seconds}>{c.label}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Total deposit (CC)">
          <input value={totalDeposit} onChange={(e) => setTotalDeposit(e.target.value)} type="number" min="0" step="0.01" style={inputStyle} />
          <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 6 }}>
            Funds{' '}
            <strong style={{ color: 'var(--fg)' }}>
              {cycles > 0 ? `${cycles} ${cycles === 1 ? 'cycle' : 'cycles'}` : '—'}
            </strong>{' '}
            of {rateNum > 0 ? rateNum : '—'} CC
            {infoQ.data ? ` · released every ${infoQ.data.tickSeconds}s or your cadence, whichever is longer` : ''}.
          </div>
        </Field>

        {error && (
          <div className="card" style={{ padding: 12, borderColor: 'var(--danger, var(--warn))', fontSize: 12, color: 'var(--warn)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
            <Lock size={14} /> {createEscrow.isPending ? 'Depositing…' : `Deposit ${depositNum || ''} CC & start`}
          </button>
          <Link to="/v1/escrows" className="btn btn-ghost">Cancel</Link>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg)',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-md)',
  padding: '8px 10px',
  fontSize: 13,
  color: 'var(--fg)',
  outline: 'none',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-4)', marginBottom: 6 }}>
        {label}
      </span>
      {children}
    </label>
  );
}
