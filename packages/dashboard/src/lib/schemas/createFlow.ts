/**
 * @module lib/schemas/createFlow
 *
 * Zod schema for the open-ended flow create form (StreamFlow —
 * non-prefunded / rolling top-up). The on-ledger `flowRate` is tokens
 * per MICROSECOND; humans enter tokens per day and the page converts.
 */

import { z } from 'zod';

/** Same relaxed party grammar as createStream: non-empty + `::`. */
const partyIdSchema = z
  .string()
  .min(3, 'Party identifier must be at least 3 characters')
  .refine((p) => p.includes('::'), {
    message: 'Party identifier must contain `::` (Hint::namespace)',
  });

/** Positive decimal-as-string (no scientific notation, no sign). */
const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal (no scientific notation, no sign)')
  .refine((s) => Number(s) > 0, { message: 'Must be greater than zero' });

/** As decimalStringSchema, but zero is a valid initial funding. */
const nonNegativeDecimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a decimal (no scientific notation, no sign)');

export const createFlowSchema = z.object({
  recipient: partyIdSchema,
  escrowOperator: partyIdSchema,
  instrumentAdmin: partyIdSchema,
  instrumentId: z.string().trim().min(1, 'Instrument id required'),
  /**
   * Tokens per DAY. Converted to per-microsecond on submit; the ledger
   * rate is rounded to 10 decimal places, so anything below ~0.00009
   * tokens/day rounds to a zero rate and is rejected on-ledger.
   */
  ratePerDay: decimalStringSchema,
  initialFunding: nonNegativeDecimalStringSchema,
});

export type CreateFlowSchemaValues = z.infer<typeof createFlowSchema>;
