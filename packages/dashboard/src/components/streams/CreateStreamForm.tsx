/**
 * Create Stream form — reference implementation for the Phase 4 form pattern.
 *
 * Demonstrates the schema-driven `<Form>` + `<FormField>` + `<FormError>`
 * primitives against `createStreamSchema`. Validation logic that used to
 * live as imperative checks inside `onSubmit` is now declarative in the
 * schema — the form just renders fields and hands typed values to the
 * `useCreateStream` mutation.
 *
 * Phase 6 (STR-117) replaces this single-page form with a 4-step wizard
 * built from the mockup; this file lands the pattern + closes STR-115.
 *
 * STR-103 note: the schema rejects `settlementMode: TokenStandardCustody`
 * with a pointer to STR-86, preventing users from hitting the runtime
 * `assertTokenStandardEscrowAvailable()` throw on submit.
 */

import { useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { CheckCircle2 } from 'lucide-react';
import Decimal from 'decimal.js';
import {
  AssetType,
  VestingMode,
  SettlementMode,
  type CreateStreamParams,
  type LedgerRecord,
  type LedgerRecordValue,
} from '@canton-streams/sdk/browser';
import { useCreateStream } from '../../hooks/useStreams.js';
import { useAuth } from '../../store/auth.js';
import { Form } from '../forms/Form.js';
import { FormField } from '../forms/FormField.js';
import { FormError } from '../forms/FormError.js';
import {
  createStreamSchema,
  type CreateStreamSchemaValues,
} from '../../lib/schemas/createStream.js';

const inputClass =
  'block w-full rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm shadow-sm placeholder:text-gray-400 focus:border-brand-500 focus:bg-white focus:ring-1 focus:ring-brand-500 transition-colors';
const selectClass =
  'block w-full rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm shadow-sm focus:border-brand-500 focus:bg-white focus:ring-1 focus:ring-brand-500 transition-colors';

const defaults: Partial<CreateStreamSchemaValues> = {
  assetType: AssetType.GlobalCip56,
  vestingMode: VestingMode.Linear,
  settlementMode: SettlementMode.UtilityHoldingCustody,
  cancellable: true,
};

export function CreateStreamForm() {
  const { party } = useAuth();
  const createStream = useCreateStream();
  const [submitError, setSubmitError] = useState<string>('');
  const [submitted, setSubmitted] = useState(false);

  const onSubmit = async (data: CreateStreamSchemaValues) => {
    if (!party) {
      setSubmitError('Wallet not connected');
      return;
    }
    setSubmitError('');
    setSubmitted(false);

    try {
      await createStream.mutateAsync(buildCreateParams(party, data));
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create stream');
    }
  };

  return (
    <Form<CreateStreamSchemaValues>
      schema={createStreamSchema}
      defaultValues={defaults}
      onSubmit={onSubmit}
      className="space-y-6 max-w-lg"
    >
      <fieldset className="space-y-5">
        <legend className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Stream configuration
        </legend>

        <FormField name="recipient" label="Recipient party" required>
          <input className={inputClass} placeholder="Alice::abc123..." />
        </FormField>

        <FormField name="totalDeposited" label="Total amount" required>
          <input
            className={inputClass}
            type="number"
            step="any"
            min="0"
            placeholder="1000.00"
          />
        </FormField>

        <div className="grid grid-cols-2 gap-4">
          <FormField name="startTime" label="Start time" required>
            <input className={inputClass} type="datetime-local" />
          </FormField>
          <FormField name="endTime" label="End time" required>
            <input className={inputClass} type="datetime-local" />
          </FormField>
        </div>

        <FormField name="assetType" label="Asset type">
          <select className={selectClass}>
            <option value={AssetType.GlobalCip56}>Global CIP-56 token</option>
            <option value={AssetType.LocalCip56}>Local CIP-56 token</option>
            <option value={AssetType.ValidatorLocalAsset}>Validator-local asset</option>
          </select>
        </FormField>

        <FormField name="vestingMode" label="Vesting mode">
          <select className={selectClass}>
            <option value={VestingMode.Linear}>Linear</option>
            <option value={VestingMode.CliffLinear}>Cliff + Linear</option>
            <option value={VestingMode.Stepped}>Stepped</option>
            <option value={VestingMode.RenewableTerm}>Renewable Term</option>
          </select>
        </FormField>

        <ConditionalVestingFields />

        <FormField name="settlementMode" label="Settlement mode">
          <select className={selectClass}>
            <option value={SettlementMode.UtilityHoldingCustody}>UtilityHoldingCustody</option>
            {/* STR-103: TokenStandardCustody disabled until Daml template lands */}
            <option value={SettlementMode.TokenStandardCustody} disabled>
              TokenStandardCustody — disabled (STR-86 pending)
            </option>
            <option value={SettlementMode.LocalAssetCustody}>LocalAssetCustody</option>
            <option value={SettlementMode.NumericLegacy}>NumericLegacy (dev)</option>
          </select>
        </FormField>

        <ConditionalSettlementFields />

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" defaultChecked className="rounded border-gray-300" />
          <span>Cancellable by sender</span>
        </label>
      </fieldset>

      {submitError && <FormError variant="block">{submitError}</FormError>}

      {submitted && !submitError && (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 flex items-center gap-2 text-sm text-emerald-800"
        >
          <CheckCircle2 size={15} className="text-emerald-600" />
          Stream proposal submitted — awaiting recipient acceptance.
        </div>
      )}

      <button
        type="submit"
        disabled={createStream.isPending}
        className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {createStream.isPending ? 'Submitting…' : 'Create stream'}
      </button>
    </Form>
  );
}

/**
 * Render extra fields conditionally based on vesting mode. Reads from
 * the FormProvider context so the parent form's `useForm` watches
 * everything in a single state tree.
 */
function ConditionalVestingFields() {
  const { watch } = useFormContext<CreateStreamSchemaValues>();
  const mode = watch('vestingMode');

  if (mode === VestingMode.CliffLinear) {
    return (
      <FormField name="cliffTime" label="Cliff time" required>
        <input className={inputClass} type="datetime-local" />
      </FormField>
    );
  }
  if (mode === VestingMode.Stepped) {
    return (
      <div className="grid grid-cols-2 gap-4">
        <FormField name="stepInterval" label="Step interval (μs)" required>
          <input className={inputClass} type="number" min="1" />
        </FormField>
        <FormField name="amountPerStep" label="Amount per step" required>
          <input className={inputClass} type="number" step="any" min="0" />
        </FormField>
      </div>
    );
  }
  if (mode === VestingMode.RenewableTerm) {
    return (
      <FormField name="termDuration" label="Term duration (μs)" required>
        <input className={inputClass} type="number" min="1" />
      </FormField>
    );
  }
  return null;
}

function ConditionalSettlementFields() {
  const { watch } = useFormContext<CreateStreamSchemaValues>();
  const mode = watch('settlementMode');

  if (mode === SettlementMode.NumericLegacy) {
    return null;
  }
  // UtilityHoldingCustody / LocalAssetCustody / TokenStandardCustody all
  // need escrowOperator + accounts; TokenStandardCustody also rejected
  // by the schema (STR-103).
  return (
    <div className="space-y-4">
      {mode !== SettlementMode.TokenStandardCustody && (
        <FormField name="holdingCid" label="Holding CID" required>
          <input className={inputClass} placeholder="00..." />
        </FormField>
      )}
      <FormField name="escrowOperator" label="Escrow operator party" required>
        <input className={inputClass} placeholder="EscrowOperator::ns" />
      </FormField>
      <FormField name="senderAccount" label="Sender account ref" required>
        <input className={inputClass} placeholder='{"custodian":"…","owner":"…","id":"…"}' />
      </FormField>
      <FormField name="recipientAccount" label="Recipient account ref" required>
        <input className={inputClass} placeholder='{"custodian":"…","owner":"…","id":"…"}' />
      </FormField>
    </div>
  );
}

/**
 * Map schema-validated values to the SDK's CreateStreamParams shape.
 * Centralizes the few coercions (number → Decimal, ISO string → Date)
 * that the schema doesn't apply.
 */
function buildCreateParams(party: string, data: CreateStreamSchemaValues): CreateStreamParams {
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
      ? { mode: VestingMode.CliffLinear as const, cliffTime: new Date(data.cliffTime) }
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
  // [STR-103] TokenStandardCustody is filtered out at schema validation;
  // unreachable here, but if a future schema change re-enables it we'd
  // wire fundingReference + accounts here too.

  return {
    ...baseConfig,
    vestingMode: vestingConfig,
    ...settlementExtras,
  } as CreateStreamParams;
}

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
