/**
 * CreateStreamWizard — STR-117 Phase 6.
 *
 * 4-step wizard ported from the mock `wizard.jsx`:
 *
 *   1. Recipient & amount   (recipient, totalDeposited, assetType)
 *   2. Schedule & vesting   (start/end + vesting mode + mode-specific fields + cancellable)
 *   3. Settlement & custody (settlement mode + custody-specific fields)
 *   4. Review & sign        (read-only summary + submit)
 *
 * Same source-of-truth as the single-page form: `createStreamSchema`
 * drives every field's validation (per-step we just call
 * `trigger(stepFields)` and only advance if it passes). Final submit
 * uses the real `useCreateStream` mutation — no mock fixtures.
 *
 * STR-103: `TokenStandardCustody` is rendered as a disabled option
 * with a tooltip pointing at STR-86, matching the schema rejection.
 */

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  useForm,
  FormProvider,
  useFormContext,
  type Resolver,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  X,
  Loader2,
  Info,
} from 'lucide-react';
import Decimal from 'decimal.js';
import {
  AssetType,
  SettlementMode,
  VestingMode,
  type CreateStreamParams,
  type LedgerRecord,
  type LedgerRecordValue,
} from '@canton-streams/sdk/browser';
import { useCreateStream } from '../../hooks/useStreams.js';
import { useAuth } from '../../store/auth.js';
import { FormField } from '../forms/FormField.js';
import { FormError } from '../forms/FormError.js';
import {
  createStreamSchema,
  type CreateStreamSchemaValues,
} from '../../lib/schemas/createStream.js';

// ---------------------------------------------------------------------------
// Step metadata
// ---------------------------------------------------------------------------

type StepId = 'recipient' | 'schedule' | 'settlement' | 'review';

interface StepDef {
  readonly id: StepId;
  readonly label: string;
}

const STEPS: readonly StepDef[] = [
  { id: 'recipient', label: 'Recipient & amount' },
  { id: 'schedule', label: 'Schedule & vesting' },
  { id: 'settlement', label: 'Settlement' },
  { id: 'review', label: 'Review & sign' },
];

/**
 * Fields validated when advancing past each step. The review step
 * runs the full schema via `handleSubmit`.
 */
function stepFields(
  stepIdx: number,
  vestingMode: VestingMode,
  settlementMode: SettlementMode,
): Array<keyof CreateStreamSchemaValues> {
  if (stepIdx === 0) {
    return ['recipient', 'totalDeposited', 'assetType'] as Array<
      keyof CreateStreamSchemaValues
    >;
  }
  if (stepIdx === 1) {
    const base = ['startTime', 'endTime', 'vestingMode', 'cancellable'];
    if (vestingMode === VestingMode.CliffLinear) base.push('cliffTime');
    if (vestingMode === VestingMode.Stepped)
      base.push('stepInterval', 'amountPerStep');
    if (vestingMode === VestingMode.RenewableTerm) base.push('termDuration');
    return base as Array<keyof CreateStreamSchemaValues>;
  }
  if (stepIdx === 2) {
    const base = ['settlementMode'];
    if (
      settlementMode === SettlementMode.UtilityHoldingCustody ||
      settlementMode === SettlementMode.LocalAssetCustody
    ) {
      base.push(
        'holdingCid',
        'escrowOperator',
        'senderAccount',
        'recipientAccount',
      );
    }
    return base as Array<keyof CreateStreamSchemaValues>;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultStartTime(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toDatetimeLocal(d);
}

function defaultEndTime(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 6);
  d.setMinutes(0, 0, 0);
  return toDatetimeLocal(d);
}

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const defaults: Partial<CreateStreamSchemaValues> = {
  assetType: AssetType.GlobalCip56,
  vestingMode: VestingMode.Linear,
  settlementMode: SettlementMode.UtilityHoldingCustody,
  cancellable: true,
  startTime: defaultStartTime(),
  endTime: defaultEndTime(),
};

// ---------------------------------------------------------------------------
// Wizard shell
// ---------------------------------------------------------------------------

export function CreateStreamWizard() {
  const { party } = useAuth();
  const createStream = useCreateStream();
  const [stepIdx, setStepIdx] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // zod's `.default()` on `cancellable` makes the *input* optional but the
  // *output* required. RHF infers field state from input; explicitly bind
  // the resolver to keep typecheck happy without weakening validation.
  const methods = useForm<CreateStreamSchemaValues>({
    resolver: zodResolver(createStreamSchema) as Resolver<CreateStreamSchemaValues>,
    defaultValues: defaults as CreateStreamSchemaValues,
    mode: 'onBlur',
  });

  const vestingMode = methods.watch('vestingMode');
  const settlementMode = methods.watch('settlementMode');

  const onNext = async () => {
    const fields = stepFields(stepIdx, vestingMode, settlementMode);
    const ok = await methods.trigger(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields as any,
      {
        shouldFocus: true,
      },
    );
    if (ok) setStepIdx((i) => Math.min(STEPS.length - 1, i + 1));
  };

  const onBack = () => setStepIdx((i) => Math.max(0, i - 1));

  const onSubmit = methods.handleSubmit(async (data) => {
    if (!party) {
      setSubmitError('Wallet not connected');
      return;
    }
    setSubmitError(null);
    setSubmitted(false);
    try {
      await createStream.mutateAsync(buildCreateParams(party, data));
      setSubmitted(true);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Failed to create stream',
      );
    }
  });

  return (
    <FormProvider {...methods}>
      <div style={{ paddingTop: 28 }}>
        <Stepper
          stepIdx={stepIdx}
          onJump={(i) => i <= stepIdx && setStepIdx(i)}
        />

        <form
          onSubmit={onSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
        >
          <div className="card" style={{ padding: 28, marginTop: 24 }}>
            {stepIdx === 0 && <StepRecipient />}
            {stepIdx === 1 && <StepSchedule />}
            {stepIdx === 2 && <StepSettlement />}
            {stepIdx === 3 && (
              <StepReview
                submitting={createStream.isPending}
                success={submitted}
                error={submitError}
              />
            )}

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: 28,
                paddingTop: 20,
                borderTop: '1px solid var(--line)',
              }}
            >
              <button
                type="button"
                className="btn btn-ghost"
                onClick={stepIdx === 0 ? undefined : onBack}
                disabled={stepIdx === 0 || createStream.isPending}
              >
                {stepIdx === 0 ? (
                  <>
                    <X size={13} /> Cancel
                  </>
                ) : (
                  <>
                    <ChevronLeft size={13} /> Back
                  </>
                )}
              </button>

              {stepIdx < STEPS.length - 1 ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onNext}
                >
                  Continue <ChevronRight size={14} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={createStream.isPending || submitted}
                >
                  {submitted ? (
                    <>
                      <Check size={14} /> Proposed
                    </>
                  ) : createStream.isPending ? (
                    <>
                      <Loader2
                        size={14}
                        style={{ animation: 'spin 800ms linear infinite' }}
                      />{' '}
                      Signing…
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} /> Sign &amp; propose
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </FormProvider>
  );
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

function Stepper({
  stepIdx,
  onJump,
}: {
  readonly stepIdx: number;
  readonly onJump: (i: number) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: 6,
      }}
    >
      {STEPS.map((step, i) => {
        const active = i === stepIdx;
        const done = i < stepIdx;
        return (
          <button
            key={step.id}
            type="button"
            onClick={() => onJump(i)}
            disabled={i > stepIdx}
            style={stepButtonStyle(active, done, i <= stepIdx)}
          >
            <div style={stepBadgeStyle(active, done)}>
              {done ? <Check size={11} /> : i + 1}
            </div>
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>{step.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const stepButtonStyle = (
  active: boolean,
  done: boolean,
  clickable: boolean,
): CSSProperties => ({
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  borderRadius: 8,
  background: active
    ? 'color-mix(in oklab, var(--accent) 12%, var(--card-2))'
    : 'transparent',
  color: active ? 'var(--accent)' : done ? 'var(--fg-2)' : 'var(--fg-4)',
  cursor: clickable ? 'pointer' : 'default',
  border: 'none',
  transition: 'background 100ms, color 100ms',
});

const stepBadgeStyle = (active: boolean, done: boolean): CSSProperties => ({
  width: 22,
  height: 22,
  borderRadius: '50%',
  border:
    '1px solid ' +
    (active
      ? 'var(--accent)'
      : done
      ? 'color-mix(in oklab, var(--accent) 50%, var(--line))'
      : 'var(--line-2)'),
  background: done
    ? 'color-mix(in oklab, var(--accent) 12%, transparent)'
    : 'transparent',
  color: active ? 'var(--accent)' : done ? 'var(--accent)' : 'var(--fg-4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 11,
  fontWeight: 600,
  flexShrink: 0,
  fontFamily: 'var(--font-mono)',
});

// ---------------------------------------------------------------------------
// Common controls
// ---------------------------------------------------------------------------

const inputClass =
  'block w-full rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm shadow-sm placeholder:text-gray-400 focus:border-brand-500 focus:bg-white focus:ring-1 focus:ring-brand-500 transition-colors';

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

function StepHeader({
  number,
  title,
  subtitle,
}: {
  readonly number: string;
  readonly title: string;
  readonly subtitle: string;
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div
        className="mono"
        style={{
          fontSize: 10.5,
          color: 'var(--fg-4)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
        }}
      >
        Step {number}
      </div>
      <h2
        style={{
          fontSize: 22,
          fontWeight: 500,
          margin: '4px 0 6px',
          color: 'var(--fg)',
        }}
      >
        {title}
      </h2>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-3)' }}>{subtitle}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Recipient
// ---------------------------------------------------------------------------

function StepRecipient() {
  return (
    <>
      <StepHeader
        number="1"
        title="Recipient & amount"
        subtitle="Who's receiving, how much, and which asset."
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <FormField name="recipient" label="Recipient party" required>
          <input
            className={inputClass}
            style={inputStyle}
            placeholder="alice::1220abcd…"
          />
        </FormField>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 200px',
            gap: 14,
          }}
        >
          <FormField name="totalDeposited" label="Total amount" required>
            <input
              className={inputClass}
              style={inputStyle}
              type="number"
              step="any"
              min="0"
              placeholder="1000.00"
            />
          </FormField>
          <FormField name="assetType" label="Asset type">
            <select
              className={inputClass}
              style={inputStyle}
            >
              <option value={AssetType.GlobalCip56}>Global CIP-56</option>
              <option value={AssetType.LocalCip56}>Local CIP-56</option>
              <option value={AssetType.ValidatorLocalAsset}>
                Validator-local
              </option>
            </select>
          </FormField>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Schedule
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function StepSchedule() {
  const { watch, setValue } = useFormContext<CreateStreamSchemaValues>();
  const vestingMode = watch('vestingMode');
  const startTime = watch('startTime');

  const presets = [
    { label: '30 days', ms: 30 * DAY },
    { label: '90 days', ms: 90 * DAY },
    { label: '6 months', ms: 6 * MONTH },
    { label: '1 year', ms: YEAR },
    { label: '4 years', ms: 4 * YEAR },
  ];

  const applyPreset = (ms: number) => {
    if (!startTime) return;
    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) return;
    const end = new Date(start.getTime() + ms);
    setValue('endTime', toDatetimeLocal(end), { shouldValidate: true });
  };

  return (
    <>
      <StepHeader
        number="2"
        title="Schedule & vesting"
        subtitle="When the stream starts, when it ends, and how funds vest."
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}
        >
          <FormField name="startTime" label="Start time" required>
            <input
              className={inputClass}
              style={inputStyle}
              type="datetime-local"
            />
          </FormField>
          <FormField name="endTime" label="End time" required>
            <input
              className={inputClass}
              style={inputStyle}
              type="datetime-local"
            />
          </FormField>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.ms)}
              style={presetChipStyle}
            >
              {p.label}
            </button>
          ))}
        </div>

        <FormField name="vestingMode" label="Vesting mode">
          <select
            className={inputClass}
            style={inputStyle}
          >
            <option value={VestingMode.Linear}>Linear — continuous</option>
            <option value={VestingMode.CliffLinear}>
              Cliff + Linear — locked until cliff
            </option>
            <option value={VestingMode.Stepped}>
              Stepped — fixed unlock chunks
            </option>
            <option value={VestingMode.RenewableTerm}>
              Renewable Term — sender extends
            </option>
          </select>
        </FormField>

        {vestingMode === VestingMode.CliffLinear && (
          <FormField name="cliffTime" label="Cliff date" required>
            <input
              className={inputClass}
              style={inputStyle}
              type="datetime-local"
            />
          </FormField>
        )}

        {vestingMode === VestingMode.Stepped && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 14,
            }}
          >
            <FormField name="stepInterval" label="Step interval (μs)" required>
              <input
                className={inputClass}
                style={inputStyle}
                type="number"
                min="1"
                placeholder="86400000000"
              />
            </FormField>
            <FormField
              name="amountPerStep"
              label="Amount per step"
              required
            >
              <input
                className={inputClass}
                style={inputStyle}
                type="number"
                step="any"
                min="0"
              />
            </FormField>
          </div>
        )}

        {vestingMode === VestingMode.RenewableTerm && (
          <FormField name="termDuration" label="Term duration (μs)" required>
            <input
              className={inputClass}
              style={inputStyle}
              type="number"
              min="1"
              placeholder="2592000000000"
            />
          </FormField>
        )}

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12.5,
            color: 'var(--fg-2)',
          }}
        >
          <input
            type="checkbox"
            {...useFormContext<CreateStreamSchemaValues>().register('cancellable')}
            defaultChecked
            style={{ accentColor: 'var(--accent)' }}
          />
          <span>Sender can cancel — recipient keeps anything vested.</span>
        </label>
      </div>
    </>
  );
}

const presetChipStyle: CSSProperties = {
  padding: '4px 10px',
  fontSize: 11.5,
  background: 'var(--card-2)',
  border: '1px solid var(--line-2)',
  borderRadius: 999,
  color: 'var(--fg-3)',
  cursor: 'pointer',
};

// ---------------------------------------------------------------------------
// Step 3: Settlement
// ---------------------------------------------------------------------------

const SETTLEMENT_OPTIONS = [
  {
    id: SettlementMode.UtilityHoldingCustody,
    label: 'Utility holding custody',
    blurb:
      'Lock a CC/USDCx holding into an escrow operator. Recommended for V1 assets.',
    tag: 'Recommended',
    disabled: false,
  },
  {
    id: SettlementMode.TokenStandardCustody,
    label: 'Token Standard custody',
    blurb:
      'CIP-56 V2 AllocationRequest. Disabled until STR-86 lands the V2-native lifecycle.',
    tag: 'STR-86',
    disabled: true,
  },
  {
    id: SettlementMode.LocalAssetCustody,
    label: 'Local asset custody',
    blurb: 'App-local Daml Finance asset with a custom adapter.',
    tag: 'Adapter',
    disabled: false,
  },
  {
    id: SettlementMode.NumericLegacy,
    label: 'Numeric (dev only)',
    blurb: 'Sandbox-only bookkeeping. No real assets move.',
    tag: 'Dev',
    disabled: false,
  },
] as const;

function StepSettlement() {
  const { watch, setValue, register } =
    useFormContext<CreateStreamSchemaValues>();
  const settlementMode = watch('settlementMode');

  return (
    <>
      <StepHeader
        number="3"
        title="Settlement & custody"
        subtitle="How the escrow holds funds and pays them out."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {SETTLEMENT_OPTIONS.map((s) => {
          const selected = settlementMode === s.id;
          return (
            <button
              key={s.id}
              type="button"
              disabled={s.disabled}
              onClick={() =>
                !s.disabled &&
                setValue('settlementMode', s.id, { shouldValidate: true })
              }
              title={s.disabled ? s.blurb : undefined}
              style={settlementOptionStyle(selected, s.disabled)}
            >
              <div
                style={radioStyle(selected, s.disabled)}
                aria-hidden="true"
              >
                {selected && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: 'var(--bg)',
                    }}
                  />
                )}
              </div>
              <div style={{ flex: 1, textAlign: 'left' }}>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 500,
                    color: s.disabled
                      ? 'var(--fg-4)'
                      : selected
                      ? 'var(--fg)'
                      : 'var(--fg-2)',
                  }}
                >
                  {s.label}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--fg-3)',
                    marginTop: 4,
                  }}
                >
                  {s.blurb}
                </div>
              </div>
              <span
                className={`badge ${
                  s.disabled ? 'muted' : selected ? 'accent' : 'muted'
                }`}
                style={{ fontSize: 10.5 }}
              >
                {s.tag}
              </span>
            </button>
          );
        })}
      </div>

      {/* hidden register so RHF tracks the field even though we set it via setValue */}
      <input type="hidden" {...register('settlementMode')} />

      {(settlementMode === SettlementMode.UtilityHoldingCustody ||
        settlementMode === SettlementMode.LocalAssetCustody) && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            marginTop: 20,
          }}
        >
          <FormField name="holdingCid" label="Funding holding CID" required>
            <input
              className={inputClass}
              style={inputStyle}
              placeholder="00abc…"
            />
          </FormField>
          <FormField name="escrowOperator" label="Escrow operator" required>
            <input
              className={inputClass}
              style={inputStyle}
              placeholder="EscrowOperator::1220…"
            />
          </FormField>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 14,
            }}
          >
            <FormField name="senderAccount" label="Sender account" required>
              <input
                className={inputClass}
                style={inputStyle}
                placeholder='{"custodian":"…","owner":"…","id":"…"}'
              />
            </FormField>
            <FormField
              name="recipientAccount"
              label="Recipient account"
              required
            >
              <input
                className={inputClass}
                style={inputStyle}
                placeholder='{"custodian":"…","owner":"…","id":"…"}'
              />
            </FormField>
          </div>
        </div>
      )}

      {settlementMode === SettlementMode.TokenStandardCustody && (
        <div
          style={{
            marginTop: 20,
            padding: '12px 14px',
            borderRadius: 'var(--r-md)',
            background: 'color-mix(in oklab, var(--warn) 8%, var(--bg-elev))',
            border:
              '1px solid color-mix(in oklab, var(--warn) 30%, var(--line))',
            fontSize: 12,
            color: 'var(--fg-2)',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
          }}
        >
          <Info size={14} style={{ color: 'var(--warn)', flexShrink: 0 }} />
          <span>
            TokenStandardCustody is disabled until STR-86 lands the V2-native
            AllocationRequest lifecycle. Pick UtilityHoldingCustody for V1
            assets (CC, USDCx) today.
          </span>
        </div>
      )}
    </>
  );
}

const settlementOptionStyle = (
  selected: boolean,
  disabled: boolean,
): CSSProperties => ({
  padding: 14,
  background: disabled
    ? 'var(--bg-elev)'
    : selected
    ? 'color-mix(in oklab, var(--accent) 8%, var(--bg-elev))'
    : 'var(--bg-elev)',
  border:
    '1px solid ' +
    (disabled
      ? 'var(--line)'
      : selected
      ? 'var(--accent-line, var(--line-2))'
      : 'var(--line-2)'),
  borderRadius: 10,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
});

const radioStyle = (
  selected: boolean,
  disabled: boolean,
): CSSProperties => ({
  width: 18,
  height: 18,
  borderRadius: '50%',
  border:
    '1px solid ' +
    (disabled
      ? 'var(--line)'
      : selected
      ? 'var(--accent)'
      : 'var(--line-2)'),
  background: selected && !disabled ? 'var(--accent)' : 'transparent',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginTop: 1,
});

// ---------------------------------------------------------------------------
// Step 4: Review
// ---------------------------------------------------------------------------

function StepReview({
  submitting,
  success,
  error,
}: {
  readonly submitting: boolean;
  readonly success: boolean;
  readonly error: string | null;
}) {
  const { watch } = useFormContext<CreateStreamSchemaValues>();
  const d = watch();

  const ratePerSec = useMemo(() => {
    const total = Number(d.totalDeposited);
    if (!total || !d.startTime || !d.endTime) return null;
    const startMs = new Date(d.startTime).getTime();
    const endMs = new Date(d.endTime).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
    const seconds = (endMs - startMs) / 1000;
    if (seconds <= 0) return null;
    return total / seconds;
  }, [d.totalDeposited, d.startTime, d.endTime]);

  return (
    <>
      <StepHeader
        number="4"
        title="Review & sign"
        subtitle="Final check before sending the proposal to the recipient."
      />

      {success && (
        <div
          style={{
            padding: 18,
            marginBottom: 16,
            background:
              'color-mix(in oklab, var(--accent) 14%, var(--card-2))',
            border:
              '1px solid color-mix(in oklab, var(--accent) 35%, var(--line-2))',
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: 'var(--accent)',
              color: '#061410',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Check size={18} />
          </div>
          <div>
            <div style={{ fontWeight: 500 }}>Stream proposed</div>
            <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
              The recipient will see this in their inbox and accept to
              activate.
            </div>
          </div>
        </div>
      )}

      <div
        style={{
          background: 'var(--bg-elev)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: 20,
        }}
      >
        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}
        >
          <ReviewRow label="Recipient" value={shortenParty(d.recipient)} />
          <ReviewRow
            label="Total"
            value={
              <span className="mono" style={{ fontSize: 16, fontWeight: 500 }}>
                {d.totalDeposited || '—'}
              </span>
            }
          />
          <ReviewRow
            label="Stream rate"
            value={
              <span
                className="mono"
                style={{ fontSize: 12.5, color: 'var(--accent)' }}
              >
                {ratePerSec
                  ? `+${ratePerSec.toFixed(6)}/s`
                  : '—'}
              </span>
            }
          />
          <ReviewRow label="Asset" value={d.assetType ?? '—'} />
          <ReviewRow
            label="Start"
            value={
              <span className="mono" style={{ fontSize: 12 }}>
                {d.startTime || '—'}
              </span>
            }
          />
          <ReviewRow
            label="End"
            value={
              <span className="mono" style={{ fontSize: 12 }}>
                {d.endTime || '—'}
              </span>
            }
          />
          <ReviewRow label="Vesting" value={d.vestingMode} />
          <ReviewRow label="Settlement" value={d.settlementMode} />
          <ReviewRow
            label="Cancellable"
            value={
              d.cancellable ? (
                <span style={{ color: 'var(--warn)' }}>Yes — by sender</span>
              ) : (
                <span style={{ color: 'var(--fg-3)' }}>No — irrevocable</span>
              )
            }
          />
        </div>
      </div>

      {error && !success && (
        <div style={{ marginTop: 14 }}>
          <FormError variant="block">{error}</FormError>
        </div>
      )}

      <div
        style={{
          marginTop: 16,
          padding: 14,
          background: 'var(--card-2)',
          borderLeft: '2px solid var(--accent)',
          borderRadius: 4,
          fontSize: 12,
          color: 'var(--fg-2)',
        }}
      >
        <div
          style={{
            fontWeight: 500,
            color: 'var(--fg)',
            marginBottom: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Info size={13} /> What happens next
        </div>
        <ol
          style={{
            paddingLeft: 18,
            margin: '6px 0 0',
            lineHeight: 1.6,
          }}
        >
          <li>You sign the propose-stream command in your wallet.</li>
          <li>
            The proposal appears in the recipient's inbox; they accept to
            activate.
          </li>
          <li>
            Once active, accruals tick continuously and the recipient can
            withdraw what's vested.
          </li>
        </ol>
      </div>
      {submitting && (
        <p
          style={{
            margin: '12px 0 0',
            fontSize: 11.5,
            color: 'var(--fg-4)',
          }}
        >
          Confirm in your wallet…
        </p>
      )}
    </>
  );
}

function ReviewRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: ReactNode;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 9.5,
          color: 'var(--fg-4)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, color: 'var(--fg-2)' }}>{value}</div>
    </div>
  );
}

function shortenParty(partyId: string | undefined): string {
  if (!partyId) return '—';
  if (partyId.length <= 22) return partyId;
  const sep = partyId.indexOf('::');
  if (sep <= 0) return partyId.slice(0, 12) + '…' + partyId.slice(-6);
  return partyId.slice(0, sep) + '::' + partyId.slice(sep + 2, sep + 10) + '…';
}

// ---------------------------------------------------------------------------
// SDK adapter (same shape as CreateStreamForm)
// ---------------------------------------------------------------------------

function parseLedgerRecord(input: string): LedgerRecord {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, LedgerRecordValue>;
    }
  } catch {
    // fall through
  }
  throw new Error('Account ref must be a JSON object');
}

function buildCreateParams(
  party: string,
  data: CreateStreamSchemaValues,
): CreateStreamParams {
  const baseConfig = {
    streamId: crypto.randomUUID(),
    sender: party,
    recipient: data.recipient,
    totalDeposited: new Decimal(data.totalDeposited),
    startTime: new Date(data.startTime),
    endTime: new Date(data.endTime),
    assetType: data.assetType,
    settlementMode: data.settlementMode,
    cancellable: data.cancellable,
  };

  const vestingConfig =
    data.vestingMode === VestingMode.Linear
      ? { mode: VestingMode.Linear as const }
      : data.vestingMode === VestingMode.CliffLinear
      ? {
          mode: VestingMode.CliffLinear as const,
          cliffTime: new Date(data.cliffTime),
        }
      : data.vestingMode === VestingMode.Stepped
      ? {
          mode: VestingMode.Stepped as const,
          stepInterval: data.stepInterval,
          amountPerStep: new Decimal(data.amountPerStep),
        }
      : {
          mode: VestingMode.RenewableTerm as const,
          termDuration: data.termDuration,
        };

  const settlementExtras: Partial<CreateStreamParams> = {};
  if (
    data.settlementMode === SettlementMode.UtilityHoldingCustody ||
    data.settlementMode === SettlementMode.LocalAssetCustody
  ) {
    Object.assign(settlementExtras, {
      holdingCid: data.holdingCid,
      escrowOperator: data.escrowOperator,
      senderAccount: parseLedgerRecord(data.senderAccount),
      recipientAccount: parseLedgerRecord(data.recipientAccount),
    });
  }

  return {
    ...baseConfig,
    vestingMode: vestingConfig,
    ...settlementExtras,
  } as CreateStreamParams;
}

// quiet `useEffect` import warning if React strict mode strips it
const _quiet: typeof useEffect = useEffect;
void _quiet;
