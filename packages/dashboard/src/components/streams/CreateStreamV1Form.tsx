/**
 * CreateStreamV1Form — create a recurring payment sent straight from the wallet.
 *
 * Deliberately minimal: who's paid, how much, and how often. The payer is always
 * the connected wallet (the proxy enforces caller === payer), so it's shown
 * read-only and injected at submit. Everything else (id, arrears handling, app
 * id) is defaulted server-side, not asked of the user.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useForm, FormProvider, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Loader2, Zap } from 'lucide-react';
import { useCreateStreamV1 } from '../../hooks/useStreams.js';
import { useCantonCoinBalance } from '../../hooks/useCantonCoinBalance.js';
import { useAssets } from '../../hooks/useAssets.js';
import { useAuth } from '../../store/auth.js';
import { FormField } from '../forms/FormField.js';
import { FormError } from '../forms/FormError.js';
import { AssetSelect } from './AssetSelect.js';
import { fmtCc, fmtAmount, instrumentLabel, displayName } from '../../lib/format.js';
import {
  createStreamV1Schema,
  type CreateStreamV1Values,
} from '../../lib/schemas/createStreamV1.js';
import type { V1CreateStreamParams } from '../../api/client.js';

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

// Inline variant for FormField labels — FormField wraps this in its own <label>
// and appends the required "*". Keeping it inline (no display:block) keeps the
// label text and the asterisk on one line instead of stacking them.
const fieldLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--fg-2)',
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

  // The wizard/other entry points may pass a recipient along; deep-links may
  // pass recipient/rate/cadence as query params. Apply each only when valid.
  const prefill = (location.state as { recipient?: string } | null) ?? null;
  const prefillFromQuery = useMemo((): Partial<CreateStreamV1Values> => {
    if (typeof window === 'undefined') return {};
    const params = new URLSearchParams(window.location.search);
    const q: Partial<CreateStreamV1Values> = {};
    const recipient = params.get('recipient');
    if (recipient) q.recipientParty = recipient;
    const rate = params.get('ratePerCycle');
    if (rate && /^\d+(\.\d+)?$/.test(rate) && Number(rate) > 0) q.ratePerCycle = rate;
    const cadence = params.get('cadence');
    if (cadence === 'hourly' || cadence === 'daily') q.cadence = cadence;
    return q;
  }, []);

  const methods = useForm<CreateStreamV1Values>({
    resolver: zodResolver(createStreamV1Schema) as Resolver<CreateStreamV1Values>,
    defaultValues: {
      ...defaults,
      ...(prefill?.recipient ? { recipientParty: prefill.recipient } : {}),
      ...prefillFromQuery,
    } as CreateStreamV1Values,
    mode: 'onBlur',
  });

  const onSubmit = methods.handleSubmit(async (data) => {
    if (!party) {
      setSubmitError('Connect a wallet first.');
      return;
    }
    setSubmitError(null);
    const params: V1CreateStreamParams = {
      payerParty: party,
      recipientParty: data.recipientParty.trim(),
      ratePerCycle: data.ratePerCycle.trim(),
      cadence: data.cadence,
      arrearsPolicy: data.arrearsPolicy,
      // Only send a key when the picker resolved a whitelisted asset; absent ⇒
      // the proxy defaults to Canton Coin.
      ...(data.assetKey ? { assetKey: data.assetKey } : {}),
    };
    try {
      const view = await createStream.mutateAsync(params);
      navigate(`/v1/streams/${encodeURIComponent(view.agreement.agreementId)}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not create the stream');
    }
  });

  const submitting = createStream.isPending;
  const cc = useCantonCoinBalance();
  const { data: assets = [] } = useAssets();
  const watchedRate = methods.watch('ratePerCycle');
  const watchedCadence = methods.watch('cadence');
  const watchedAssetKey = methods.watch('assetKey');
  const rateNum = Number(watchedRate);
  const hasRate = !!watchedRate && Number.isFinite(rateNum) && rateNum > 0;
  const perDayMult: Record<string, number> = { second: 86_400, minute: 1_440, hourly: 24, daily: 1 };
  const perDay = hasRate ? rateNum * (perDayMult[watchedCadence] ?? 1) : 0;
  // Canton Coin is the only asset with a live wallet-balance readout here, so the
  // balance/low-funds strip is shown for CC and the amounts carry the selected
  // asset's symbol for anything else.
  const selectedAsset = assets.find((a) => a.key === watchedAssetKey);
  const isCc = !watchedAssetKey || watchedAssetKey === 'cc';
  const unit = isCc ? 'CC' : instrumentLabel(selectedAsset?.instrumentId);
  const lowBalance = isCc && hasRate && cc.value !== null && cc.value < rateNum;

  return (
    <FormProvider {...methods}>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 560 }}>
        <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Payer — read-only, from the wallet */}
          <div>
            <label style={labelStyle}>From (your wallet)</label>
            <div style={{ ...inputStyle, color: party ? 'var(--fg)' : 'var(--fg-4)' }} title={party ?? undefined}>
              {party ? displayName(party) : 'Not connected'}
            </div>
          </div>

          <FormField
            name="recipientParty"
            className=""
            label={<span style={fieldLabelStyle}>Recipient</span>}
            required
            help="The wallet address you want to pay."
          >
            <input className="input" style={inputStyle} placeholder="Recipient's wallet address" autoComplete="off" />
          </FormField>

          {/* Asset picker — writes the whitelisted `assetKey` sent to the proxy.
              Whitelist-only (no custom): the V1 lane rejects unknown keys. */}
          <AssetSelect keyName="assetKey" allowCustom={false} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
            <FormField
              name="ratePerCycle"
              className=""
              label={<span style={fieldLabelStyle}>Amount per payment</span>}
              required
              help="How much to send each time."
            >
              <input className="input" style={inputStyle} placeholder="10" inputMode="decimal" autoComplete="off" />
            </FormField>

            <FormField
              name="cadence"
              className=""
              label={<span style={fieldLabelStyle}>How often</span>}
            >
              <select className="input" style={inputStyle}>
                <option value="second">Every second</option>
                <option value="minute">Every minute</option>
                <option value="hourly">Every hour</option>
                <option value="daily">Every day</option>
              </select>
            </FormField>
          </div>
        </div>

        {/* Cost + balance preview */}
        {hasRate && (
          <div
            className="card"
            style={{
              padding: 16, display: 'flex', flexDirection: 'column', gap: 8,
              borderColor: lowBalance ? 'color-mix(in oklab, var(--warn) 45%, var(--line))' : 'var(--line-2)',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 12.5 }}>
              <span style={{ color: 'var(--fg-3)' }}>Each payment: <strong style={{ color: 'var(--fg)' }}>{fmtAmount(rateNum)} {unit}</strong></span>
              <span style={{ color: 'var(--fg-3)' }}>Per day: <strong style={{ color: 'var(--fg)' }}>{fmtAmount(perDay)} {unit}</strong></span>
              {isCc && (
                <span style={{ color: 'var(--fg-3)' }}>
                  Your balance:{' '}
                  <strong style={{ color: lowBalance ? 'var(--warn)' : 'var(--fg)' }}>
                    {cc.isLoading ? '…' : cc.display !== null ? fmtCc(Number(cc.display)) : '—'}
                  </strong>
                </span>
              )}
            </div>
            {lowBalance && (
              <div style={{ fontSize: 12, color: 'var(--warn)' }}>
                Your balance is below one payment ({fmtCc(rateNum)}). You can still create the stream,
                but payments will wait until you top up.
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
          <button type="submit" className="btn btn-primary" disabled={submitting || !party} style={{ minWidth: 160, justifyContent: 'center' }}>
            {submitting ? (
              <><Loader2 size={14} style={{ animation: 'spin 800ms linear infinite' }} /> Creating…</>
            ) : (
              <><Zap size={14} /> Create stream</>
            )}
          </button>
        </div>

        {createStream.isSuccess && !submitError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--accent)' }}>
            <Check size={14} /> Stream created — opening it now…
          </div>
        )}
      </form>
    </FormProvider>
  );
}
