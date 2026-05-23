/**
 * @module lib/schemas/batchRow
 *
 * Zod schema for one row of a batch CSV. Validates that every row
 * carries the minimal fields needed to issue a `useCreateStream`
 * mutation against the proxy — the rest of the create-stream config
 * is derived (settlement mode comes from the page-level selector;
 * vesting-specific extras are inferred from the vesting column).
 *
 * Phase 6 (STR-117) — BatchPage.
 */

import { z } from 'zod';
import { VestingMode } from '@canton-streams/sdk/browser';

const partyIdSchema = z
  .string()
  .min(3, 'recipient party id too short')
  .refine((p) => p.includes('::'), {
    message: 'recipient must contain `::` (Hint::namespace)',
  });

const decimalStringSchema = z
  .string()
  .regex(
    /^\d+(\.\d+)?$/,
    'amount must be a positive decimal (no scientific notation)',
  )
  .refine((s) => Number(s) > 0, { message: 'amount must be > 0' });

const dateInputSchema = z
  .string()
  .min(1, 'required')
  .refine((s) => !Number.isNaN(new Date(s).getTime()), {
    message: 'invalid ISO/date string',
  });

const cancellableSchema = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    const s = v.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(s)) return true;
    if (['false', 'no', 'n', '0', ''].includes(s)) return false;
    return v;
  })
  .pipe(z.boolean());

const vestingModeSchema = z.enum(VestingMode);

export const batchRowSchema = z
  .object({
    recipient: partyIdSchema,
    amount: decimalStringSchema,
    asset: z.string().min(1, 'asset required'),
    start: dateInputSchema,
    end: dateInputSchema,
    vesting: vestingModeSchema,
    cancellable: cancellableSchema.default(true),
  })
  .refine(
    (row) => new Date(row.start).getTime() < new Date(row.end).getTime(),
    { message: 'end must be strictly after start', path: ['end'] },
  );

export type BatchRow = z.infer<typeof batchRowSchema>;
