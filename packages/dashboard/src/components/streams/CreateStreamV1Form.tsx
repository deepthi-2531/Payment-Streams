/**
 * CreateStreamV1Form — single-card form for the proxy V1 lane.
 *
 * V1 is the proven token-standard direct-delivery flow: the payer accrues
 * `ratePerCycle` per cadence period and each settle draws one cycle from the
 * payer's wallet. There is NO funding lock at create time, so the form is a
 * flat single step (recipient, rate, cadence, optional id) rather than the
 * 4-step V2 custody wizard.
 *
 * `payerParty` is always the connected wallet party (the proxy enforces
 * caller === payerParty), so it is shown read-only and injected at submit —
 * never typed by the user. Submit POSTs to `/api/v1/streams` via
 * `useCreateStreamV1`, then navigates to the new V1 stream detail page.
 */

import { useState, type CSSProperties } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useForm, FormProvider, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Loader2, Info, Zap } from 'lucide-react';
import { useCreateStreamV1 } from '../../hooks/useStreams.js';
import { useCantonCoinBalance } from '../../hooks/useCantonCoinBalance.js';
import { useAuth } from '../../store/auth.js';
import { FormField } from '../forms/FormField.js';
import { FormError } from '../forms/FormError.js';
import { partyShort } from '../primitives/PartyChip.js';
import {
  createStreamV1Schema,
  type CreateStreamV1Values,
} from '../../lib/schemas/createStreamV1.js';
import type { V1CreateStreamParams } from '../../api/client.js';

const ENABLE_V1_RECEIVER_CLAIM = import.meta.env.VITE_ENABLE_V1_RECEIVER_CLAIM === 'true';

const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  background: 'var(--bg-elev)',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-sm)',
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--fg)',
  outline: 'none',
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--fg-2)',
  marginBottom: 6,
};

const defaults: Partial<CreateStreamV1Values> = {
  cadence: 'daily',
  arrearsPolicy: 'catch-up',
};

export function CreateStreamV1Form() {
  const { party } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const createStream = useCreateStreamV1();
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The main create wizard's "Direct delivery (V1)" card routes here and may
  // carry the recipient the user already typed, so it isn't lost on the hop.
  const prefill = (location.state as { recipient?: string } | null) ?? null;

  const methods = useForm<CreateStreamV1Values>({
    resolver: zodResolver(createStreamV1Schema) as Resolver<CreateStreamV1Values>,
    defaultValues: {
      ...defaults,
      ...(prefill?.recipient ? { recipientParty: prefill.recipient } : {}),
    } as CreateStreamV1Values,
    mode: 'onBlur',
  });

  const onSubmit = methods.handleSubmit(async (data) => {
    if (!party) {
      setSubmitError('Wallet not connected — connect a wallet to set the payer party.');
      return;
    }
    setSubmitError(null);
    const trimmedId = data.streamId?.trim();
    const trimmedApp = data.appId?.trim();
    const params: V1CreateStreamParams = {
      payerParty: party,
      recipientParty: data.recipientParty.trim(),
      ratePerCycle: data.ratePerCycle.trim(),
      cadence: data.cadence,
      arrearsPolicy: data.arrearsPolicy,
      ...(trimmedId ? { streamId: trimmedId } : {}),
      ...(trimmedApp ? { appId: trimmedApp } : {}),
    };
    try {
      const view = await createStream.mutateAsync(params);
      navigate(`/v1/streams/${encodeURIComponent(view.agreement.agreementId)}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create V1 stream');
    }
  });

  const submitting = createStream.isPending;

  // Live cost preview: what each settle (and a day of settles) will draw from
  // the wallet, plus the current CC balance — so the user sees the cost and
  // whether they can afford a cycle BEFORE committing to the stream.
  const cc = useCantonCoinBalance();
  // Public hosted-wallet demos use the no-DAR direct-delivery path. Receiver
  // claim is opt-in for controlled validators that have vetted the V1 shim DAR
  // on the payer's participant.
  const [mode, setMode] = useState<'escrow' | 'direct'>('direct');
  const watchedRate = methods.watch('ratePerCycle');
  const watchedCadence = methods.watch('cadence');
  const rateNum = Number(watchedRate);
  const hasRate = !!watchedRate && Number.isFinite(rateNum) && rateNum > 0;
  const perDayMult: Record<string, number> = {
    second: 86_400,
    minute: 1_440,
    hourly: 24,
    daily: 1,
  };
  const perDay = hasRate ? rateNum * (perDayMult[watchedCadence] ?? 1) : 0;
  const lowBalance = hasRate && cc.value !== null && cc.value < rateNum;
  const fmtCC = (n: number): string =>
    `${n.toLocaleString(undefined, { maximumFractionDigits: 10 })} CC`;

  return (
    <FormProvider {...methods}>
      <form
        onSubmit={onSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 620 }}
      >
        {/* Payout model — direct delivery by default; receiver-claim is gated. */}
        <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>
            How does the recipient get paid?
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {(
              [
                {
                  v: 'direct',
                  t: 'Per-cycle payment',
                  d: 'You press Settle each cycle. If the recipient is pre-approved it lands instantly; otherwise it waits as a pending offer they accept. No custom DAR.',
                },
                ...(ENABLE_V1_RECEIVER_CLAIM
                  ? [
                      {
                        v: 'escrow',
                        t: 'Escrow — recipient claims',
                        d: 'Requires canton-streams-v1-shim vetted on the payer participant. Use only on controlled validators.',
                      },
                    ] as const
                  : []),
              ] as const
            ).map((o) => (
              <button
                type="button"
                key={o.v}
                onClick={() => setMode(o.v)}
                style={{
                  flex: '1 1 240px',
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: 'var(--r-sm)',
                  border: `1px solid ${mode === o.v ? 'var(--accent)' : 'var(--line-2)'}`,
                  background: mode === o.v ? 'var(--accent-soft)' : 'transparent',
                  cursor: 'pointer',
                  color: 'var(--fg)',
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{o.t}</div>
                <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2 }}>{o.d}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Mode explainer */}
        <div
          className="card"
          style={{
            padding: 14,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            background: 'var(--accent-soft)',
            border: '1px solid color-mix(in oklab, var(--accent) 35%, var(--line))',
          }}
        >
          <Info size={15} style={{ color: 'var(--accent)', marginTop: 1, flexShrink: 0 }} />
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
            {mode === 'escrow' ? (
              <>
                <strong style={{ color: 'var(--fg)' }}>Escrow — recipient claims.</strong>{' '}
                On the stream page you press <em>Send for claim</em> each cycle. This path
                creates a <span className="mono">ReceiverClaimV1</span> contract, so it only
                works when your wallet participant has vetted the Streams V1 shim DAR.
              </>
            ) : (
              <>
                <strong style={{ color: 'var(--fg)' }}>Per-cycle payment.</strong>{' '}
                Each time you press <em>Settle</em>, the rate below is drawn from{' '}
                <strong>your wallet</strong>. If the recipient holds a{' '}
                <span className="mono">TransferPreapproval</span> it lands instantly; otherwise it
                becomes a <strong>pending offer</strong> they accept in their own wallet (and you
                can withdraw/retry it if they don’t accept before it expires). This is the live
                TestNet path for Loop/PartyLayer — only network-vetted token-standard packages,
                no custom DAR.
              </>
            )}
          </div>
        </div>

        <div className="card" style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Payer — read-only, from the wallet */}
          <div>
            <label style={labelStyle}>Payer party (your wallet)</label>
            <div
              style={{
                ...inputStyle,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: party ? 'var(--fg)' : 'var(--fg-4)',
              }}
              title={party ?? undefined}
            >
              <span
                className="mono"
                style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {party ? `${party.split('::')[0]} · ${partyShort(party)}…` : 'Not connected'}
              </span>
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--fg-4)' }}>
              The proxy requires the caller to equal the payer; this is fixed to
              your connected wallet.
            </p>
          </div>

          <FormField
            name="recipientParty"
            label={<span style={labelStyle}>Recipient party</span>}
            required
            help="Who receives the CC. They must already have a TransferPreapproval set up to accept Canton Coin."
          >
            <input
              className="input"
              style={inputStyle}
              placeholder="Bob::1220abc…"
              autoComplete="off"
            />
          </FormField>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <FormField
              name="ratePerCycle"
              label={<span style={labelStyle}>Rate per cycle (CC)</span>}
              required
              help="Canton Coin sent to the recipient on each settle. e.g. 10 = 10 CC drawn from your wallet per cycle."
            >
              <input
                className="input"
                style={inputStyle}
                placeholder="10.00"
                inputMode="decimal"
                autoComplete="off"
              />
            </FormField>

            <FormField
              name="cadence"
              label={<span style={labelStyle}>Cycle length</span>}
              help="One “cycle” = one of these periods’ worth of rate."
            >
              <select className="input" style={inputStyle}>
                <option value="second">Per second</option>
                <option value="minute">Per minute</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
              </select>
            </FormField>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <FormField
              name="arrearsPolicy"
              label={<span style={labelStyle}>Arrears policy</span>}
              help="Catch up: one Settle pays every cycle missed since the last one (can be several × the rate at once). Skip missed: each Settle pays at most one cycle."
            >
              <select className="input" style={inputStyle}>
                <option value="catch-up">Catch up (settle all missed)</option>
                <option value="skip-missed">Skip missed</option>
              </select>
            </FormField>

            <FormField
              name="streamId"
              label={<span style={labelStyle}>Stream id (optional)</span>}
              help="Auto-generated when blank."
            >
              <input
                className="input"
                style={inputStyle}
                placeholder="v1-payroll-bob"
                autoComplete="off"
              />
            </FormField>
          </div>

          <FormField
            name="appId"
            label={<span style={labelStyle}>App id (optional)</span>}
            help="Stamped on each transfer (cantonstreams.dev/app)."
          >
            <input
              className="input"
              style={inputStyle}
              placeholder="my-app"
              autoComplete="off"
            />
          </FormField>
        </div>

        {/* Live cost + balance preview — what this stream draws per settle and
            whether the wallet can currently cover a cycle. */}
        {hasRate && (
          <div
            className="card"
            style={{
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              borderColor: lowBalance
                ? 'color-mix(in oklab, var(--warn) 45%, var(--line))'
                : 'var(--line-2)',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 12.5 }}>
              <span style={{ color: 'var(--fg-3)' }}>
                Per settle:{' '}
                <span className="mono" style={{ color: 'var(--fg)' }}>{fmtCC(rateNum)}</span>
              </span>
              <span style={{ color: 'var(--fg-3)' }}>
                Per day:{' '}
                <span className="mono" style={{ color: 'var(--fg)' }}>{fmtCC(perDay)}</span>
              </span>
              <span style={{ color: 'var(--fg-3)' }}>
                Wallet balance:{' '}
                <span
                  className="mono"
                  style={{ color: lowBalance ? 'var(--warn)' : 'var(--fg)' }}
                >
                  {cc.isLoading ? '…' : cc.display !== null ? fmtCC(Number(cc.display)) : '—'}
                </span>
              </span>
            </div>
            {lowBalance && (
              <div style={{ fontSize: 12, color: 'var(--warn)' }}>
                Your wallet holds less than one cycle ({fmtCC(rateNum)}). You can still
                create the stream, but Settle will fail until you top up your wallet.
              </div>
            )}
          </div>
        )}

        {submitError && (
          <div className="card" style={{ padding: 14, borderColor: 'var(--danger)' }}>
            <FormError>{submitError}</FormError>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !party}
            style={{ minWidth: 170, justifyContent: 'center' }}
          >
            {submitting ? (
              <>
                <Loader2 size={14} style={{ animation: 'spin 800ms linear infinite' }} /> Creating…
              </>
            ) : (
              <>
                <Zap size={14} /> Create V1 stream
              </>
            )}
          </button>
        </div>

        {createStream.isSuccess && !submitError && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12.5,
              color: 'var(--accent)',
            }}
          >
            <Check size={14} /> Stream created — redirecting to detail…
          </div>
        )}
      </form>
    </FormProvider>
  );
}
