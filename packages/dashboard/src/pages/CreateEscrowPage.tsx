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
import { useCreateEscrow } from '../hooks/useEscrows.js';
import { useAssets } from '../hooks/useAssets.js';
import { useCantonCoinBalance } from '../hooks/useCantonCoinBalance.js';
import { PageHeader } from '../components/common/index.js';
import { fmtCc, displayName } from '../lib/format.js';

const CADENCES = [
  { label: 'Every minute', seconds: 60 },
  { label: 'Every hour', seconds: 3600 },
  { label: 'Every day', seconds: 86400 },
] as const;

export function CreateEscrowPage() {
  const { party } = useAuth();
  const navigate = useNavigate();
  const createEscrow = useCreateEscrow();
  const cc = useCantonCoinBalance();

  const [recipient, setRecipient] = useState('');
  const [rate, setRate] = useState('1');
  const [cadenceSeconds, setCadenceSeconds] = useState<number>(86400);
  const [totalDeposit, setTotalDeposit] = useState('10');
  const [assetKey, setAssetKey] = useState('cc');
  const [error, setError] = useState<string | null>(null);
  const { data: assets = [] } = useAssets();

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
        ...(assetKey && assetKey !== 'cc' ? { assetKey } : {}),
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
        <ArrowLeft size={13} /> Vault streams
      </Link>

      <PageHeader
        title="New vault stream"
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
          <strong style={{ color: 'var(--fg)' }}>Deposit once — then it runs on its own.</strong> You put
          the full amount into the vault and approve it a single time. From there the operator pays the
          recipient on your schedule, so you don't have to sign off on every payment. Changed your mind?
          Stop anytime and whatever hasn't been paid out comes straight back to you. Prefer to keep the
          funds in your own wallet and approve each payment yourself? Use a{' '}
          <Link to="/v1/create" style={{ color: 'var(--accent)' }}>direct-delivery stream</Link> instead.
        </div>
      </div>

      <div className="card" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <Field label="From (you)">
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }} title={party ?? undefined}>
            {party ? displayName(party) : 'Not connected'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 3 }}>
            Balance: {cc.isLoading ? '…' : fmtCc(cc.value ?? cc.display)}
          </div>
        </Field>

        <Field label="Recipient">
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Recipient's wallet address"
            style={inputStyle}
          />
          {recipient.trim() && !validRecipient && (
            <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>
              That doesn't look like a full wallet address.
            </div>
          )}
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Amount per payment (CC)">
            <input value={rate} onChange={(e) => setRate(e.target.value)} type="number" min="0" step="0.01" style={inputStyle} />
          </Field>
          <Field label="How often">
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

        {assets.length > 1 && (
          <Field label="Asset">
            <select value={assetKey} onChange={(e) => setAssetKey(e.target.value)} style={inputStyle}>
              {assets.map((a) => (
                <option key={a.key} value={a.key}>{a.displayName || a.key}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label={`Total deposit (${(assetKey || 'cc').toUpperCase()})`}>
          <input value={totalDeposit} onChange={(e) => setTotalDeposit(e.target.value)} type="number" min="0" step="0.01" style={inputStyle} />
          <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 6 }}>
            Covers{' '}
            <strong style={{ color: 'var(--fg)' }}>
              {cycles > 0 ? `${cycles} ${cycles === 1 ? 'payment' : 'payments'}` : '—'}
            </strong>{' '}
            of {rateNum > 0 ? fmtCc(rateNum) : '—'}.
          </div>
        </Field>

        {error && (
          <div className="card" style={{ padding: 12, borderColor: 'var(--danger, var(--warn))', fontSize: 12, color: 'var(--warn)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
            <Lock size={14} /> {createEscrow.isPending ? 'Funding…' : `Fund ${depositNum ? fmtCc(depositNum) : ''} & start`}
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
