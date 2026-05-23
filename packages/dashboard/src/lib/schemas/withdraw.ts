/**
 * @module lib/schemas/withdraw
 *
 * Zod schema for the Withdraw modal. The Daml side requires no inputs
 * beyond the stream contract id (the choice is non-consuming on the
 * recipient's authority + computes accrued internally), but for
 * TokenStandardCustody streams the SDK requires the off-chain
 * settlement reference + confirmed settled amount.
 */

import { z } from 'zod';
import { SettlementMode } from '@canton-streams/sdk/browser';

const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal');

/**
 * Withdraw form. For NumericLegacy / UtilityHoldingCustody / LocalAssetCustody
 * the form is effectively a confirm dialog (only `partial` / `amount` matter).
 * TokenStandardCustody also blocked at the schema layer until STR-103 is
 * resolved by STR-86.
 */
export const withdrawSchema = z.discriminatedUnion('settlementMode', [
  z.object({
    settlementMode: z.literal(SettlementMode.NumericLegacy),
    partial: z.boolean().default(false),
    amount: decimalStringSchema.optional(),
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.UtilityHoldingCustody),
    partial: z.boolean().default(false),
    amount: decimalStringSchema.optional(),
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.LocalAssetCustody),
    partial: z.boolean().default(false),
    amount: decimalStringSchema.optional(),
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.TokenStandardCustody),
    partial: z.boolean().default(false),
    amount: decimalStringSchema.optional(),
    settlementReference: z.string().min(1),
    settledAmount: decimalStringSchema,
  }).refine(() => false, {
    message:
      'TokenStandardCustody withdraw not available — Daml template missing ' +
      '(STR-103). Track lifecycle migration in STR-86.',
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.Delegated),
    partial: z.boolean().default(false),
    amount: decimalStringSchema.optional(),
  }),
]).refine(
  (v) => !v.partial || (typeof v.amount === 'string' && v.amount.length > 0),
  { message: 'amount is required when partial=true', path: ['amount'] },
);

export type WithdrawSchemaValues = z.infer<typeof withdrawSchema>;
