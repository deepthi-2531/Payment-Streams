/**
 * @module lib/schemas/createStream
 *
 * Zod schema for the Create Stream wizard. Drives both client-side
 * form validation (via @hookform/resolvers/zod) and the disabled-state
 * gate against settlement modes whose Daml template is not currently
 * shipped (STR-103: TokenStandardCustody).
 */

import { z } from 'zod';
import { SettlementMode, VestingMode, AssetType } from '@canton-streams/sdk/browser';

/**
 * Party identifier — `Hint::namespace-fingerprint`. We don't enforce the
 * exact format because the Canton party id grammar is more permissive than
 * a tight regex would capture; we just require non-empty + the `::`
 * separator.
 */
const partyIdSchema = z
  .string()
  .min(3, 'Party identifier must be at least 3 characters')
  .refine((p) => p.includes('::'), {
    message: 'Party identifier must contain `::` (Hint::namespace)',
  });

/**
 * Decimal-as-string. Accepts integer + decimal notation; rejects
 * scientific notation, leading/trailing whitespace, and signs.
 */
const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal (no scientific notation, no sign)')
  .refine((s) => Number(s) > 0, { message: 'Must be greater than zero' });

/** ISO-8601 timestamp string from `<input type="datetime-local">`. */
const datetimeLocalSchema = z
  .string()
  .min(1, 'Required')
  .refine((s) => !Number.isNaN(new Date(s).getTime()), {
    message: 'Invalid timestamp',
  });

/**
 * Vesting-mode-specific extra fields. Keyed by mode; the discriminated
 * union ensures each variant has exactly the fields the SDK shape needs.
 */
const vestingConfigSchema = z.discriminatedUnion('vestingMode', [
  z.object({
    vestingMode: z.literal(VestingMode.Linear),
  }),
  z.object({
    vestingMode: z.literal(VestingMode.CliffLinear),
    cliffTime: datetimeLocalSchema,
  }),
  z.object({
    vestingMode: z.literal(VestingMode.Stepped),
    stepInterval: z.number().int().positive('stepInterval must be > 0'),
    amountPerStep: decimalStringSchema,
  }),
  z.object({
    vestingMode: z.literal(VestingMode.RenewableTerm),
    termDuration: z.number().int().positive('termDuration must be > 0'),
  }),
]);

/**
 * Per-mode settlement extras. Conditional shape that mirrors what
 * `commands/create.ts` requires per `SettlementMode`.
 *
 * [STR-103] `TokenStandardCustody` is REJECTED at the schema level
 * because the Daml template doesn't exist (`assertTokenStandardEscrowAvailable`
 * throws at runtime). We surface this in the wizard with a disabled
 * option + tooltip referencing STR-86 (lifecycle migration).
 */
const settlementConfigSchema = z.discriminatedUnion('settlementMode', [
  z.object({
    settlementMode: z.literal(SettlementMode.NumericLegacy),
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.UtilityHoldingCustody),
    holdingCid: z.string().min(1, 'holdingCid required for UtilityHoldingCustody'),
    escrowOperator: partyIdSchema,
    senderAccount: z.string().min(1, 'senderAccount required'),
    recipientAccount: z.string().min(1, 'recipientAccount required'),
  }),
  // STR-103: TokenStandardCustody intentionally REJECTED at schema validation time.
  z.object({
    settlementMode: z.literal(SettlementMode.TokenStandardCustody),
    fundingReference: z.string().min(1, 'fundingReference required for TokenStandardCustody'),
    escrowOperator: partyIdSchema,
    senderAccount: z.string().min(1, 'senderAccount required'),
    recipientAccount: z.string().min(1, 'recipientAccount required'),
  }).refine(() => false, {
    message:
      'TokenStandardCustody is not currently available — Daml template missing ' +
      '(see STR-103). Use UtilityHoldingCustody until STR-86 lands the ' +
      'AllocationRequest-driven lifecycle.',
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.LocalAssetCustody),
    holdingCid: z.string().min(1, 'holdingCid required for LocalAssetCustody'),
    escrowOperator: partyIdSchema,
    senderAccount: z.string().min(1, 'senderAccount required'),
    recipientAccount: z.string().min(1, 'recipientAccount required'),
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.Delegated),
  }),
]);

/**
 * V1 instrument reference (4-field). Optional at this layer because
 * NumericLegacy streams don't need it; downstream schemas refine.
 */
const instrumentRefSchema = z.object({
  depository: partyIdSchema,
  issuer: partyIdSchema,
  instrumentId: z.string().min(1),
  instrumentVersion: z.string().min(1),
});

/**
 * Top-level Create Stream form schema. Refined to enforce
 * cross-field invariants like `startTime < endTime`.
 */
export const createStreamSchema = z
  .object({
    recipient: partyIdSchema,
    totalDeposited: decimalStringSchema,
    assetType: z.enum(AssetType),
    instrumentRef: instrumentRefSchema.optional(),
    startTime: datetimeLocalSchema,
    endTime: datetimeLocalSchema,
    cancellable: z.boolean().default(true),
  })
  .and(vestingConfigSchema)
  .and(settlementConfigSchema)
  .refine(
    (data) => new Date(data.startTime).getTime() < new Date(data.endTime).getTime(),
    {
      message: 'endTime must be strictly after startTime',
      path: ['endTime'],
    },
  )
  .refine(
    (data) =>
      data.vestingMode !== VestingMode.CliffLinear ||
      (new Date(data.startTime).getTime() <= new Date(data.cliffTime).getTime() &&
        new Date(data.cliffTime).getTime() < new Date(data.endTime).getTime()),
    {
      message: 'cliffTime must satisfy startTime ≤ cliffTime < endTime',
      path: ['cliffTime'],
    },
  );

export type CreateStreamSchemaValues = z.infer<typeof createStreamSchema>;
