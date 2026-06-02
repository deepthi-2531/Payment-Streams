/**
 * @module lib/schemas/createStream
 *
 * Zod schema for the Create Stream wizard. Drives both client-side
 * form validation (via @hookform/resolvers/zod). The create flow is
 * V2-only: CIP-56 V2 assets via CIP-0112 AllocationRequest semantics.
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
 * V2 settlement extras. Legacy modes remain in the SDK enum so old
 * persisted payloads can parse, but new dashboard submissions are
 * TokenStandardCustody only.
 */
const settlementConfigSchema = z.object({
  settlementMode: z.literal(SettlementMode.TokenStandardCustody),
  fundingReference: z.string().min(1, 'fundingReference required for V2 allocation funding'),
  escrowOperator: partyIdSchema,
  senderAccount: z.string().min(1, 'senderAccount required'),
  recipientAccount: z.string().min(1, 'recipientAccount required'),
});

/**
 * V2 asset address as exposed to humans. The SDK still bridges through
 * `InstrumentRef` internally, so buildCreateParams maps this to
 * `{ depository: admin, issuer: admin, instrumentId, instrumentVersion: "v2" }`.
 */
const instrumentAdminSchema = partyIdSchema;
const instrumentIdSchema = z.string().trim().min(1, 'Instrument id required');

/**
 * Top-level Create Stream form schema. Refined to enforce
 * cross-field invariants like `startTime < endTime`.
 */
export const createStreamSchema = z
  .object({
    recipient: partyIdSchema,
    totalDeposited: decimalStringSchema,
    assetType: z.enum(AssetType),
    instrumentAdmin: instrumentAdminSchema,
    instrumentId: instrumentIdSchema,
    startTime: datetimeLocalSchema,
    endTime: datetimeLocalSchema,
    cancellable: z.boolean().default(true),
  })
  .and(vestingConfigSchema)
  .and(settlementConfigSchema)
  .refine((data) => new Date(data.startTime).getTime() < new Date(data.endTime).getTime(), {
    message: 'endTime must be strictly after startTime',
    path: ['endTime'],
  })
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
