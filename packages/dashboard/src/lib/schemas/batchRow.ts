/**
 * @module lib/schemas/batchRow
 *
 * Zod schema for one row of a batch CSV. Validates that every row
 * carries the fields needed to issue a V2-only `useCreateStream`
 * mutation against the proxy. Vesting-specific extras are inferred from
 * the vesting column; funding/account fields must come from the Amulet
 * wallet / token-standard flow and are never defaulted to legacy modes.
 *
 * Phase 6 (STR-117) — BatchPage.
 */

import { z } from 'zod';
import { VestingMode } from '@canton-streams/sdk/browser';
import type { LedgerRecord } from '@canton-streams/sdk/browser';

const partyIdSchema = z
  .string()
  .min(3, 'party id too short')
  .refine((p) => p.includes('::'), {
    message: 'party id must contain `::` (Hint::namespace)',
  });

const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'amount must be a positive decimal (no scientific notation)')
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

// Per-variant optional columns. CSV cells arrive as strings; empty
// strings mean "not supplied" rather than "invalid". `z.preprocess`
// normalizes the empty/undefined cases up-front so the inner schemas
// can stay clean and the type inference stays honest.

const emptyAsUndefined = (v: unknown): unknown =>
  v === '' || v === undefined || v === null ? undefined : v;

/** Optional positive-integer microsecond column (stepInterval, termDuration). */
const optionalPositiveIntMicrosSchema = z.preprocess(
  emptyAsUndefined,
  z.coerce
    .number()
    .int('must be a whole number of microseconds')
    .positive('must be > 0')
    .optional(),
);

/** Optional decimal column (amountPerStep). */
const optionalDecimalStringSchema = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'must be a positive decimal')
    .refine((s) => Number(s) > 0, { message: 'must be > 0' })
    .optional(),
);

/** Optional ISO date column (cliffTime). */
const optionalDateInputSchema = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(new Date(s).getTime()), {
      message: 'invalid ISO/date string',
    })
    .optional(),
);

const ledgerRecordJsonSchema = z.string().transform((value, ctx) => {
  try {
    const parsed = JSON.parse(value) as LedgerRecord;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a non-empty JSON object',
      });
      return z.NEVER;
    }
    return parsed;
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be valid JSON (${err instanceof Error ? err.message : String(err)})`,
    });
    return z.NEVER;
  }
});

export const batchRowSchema = z
  .object({
    recipient: partyIdSchema,
    amount: decimalStringSchema,
    asset: z.string().min(1, 'asset required'),
    instrumentAdmin: partyIdSchema,
    fundingReference: z.string().min(1, 'fundingReference required'),
    senderAccount: ledgerRecordJsonSchema,
    recipientAccount: ledgerRecordJsonSchema,
    escrowOperator: partyIdSchema,
    start: dateInputSchema,
    end: dateInputSchema,
    vesting: vestingModeSchema,
    cancellable: cancellableSchema.default(true),
    /** Required when `vesting === CliffLinear`. ISO date string. */
    cliffTime: optionalDateInputSchema,
    /** Required when `vesting === Stepped`. Microseconds between steps. */
    stepInterval: optionalPositiveIntMicrosSchema,
    /** Required when `vesting === Stepped`. Decimal amount unlocked per step. */
    amountPerStep: optionalDecimalStringSchema,
    /** Required when `vesting === RenewableTerm`. Microseconds in one term. */
    termDuration: optionalPositiveIntMicrosSchema,
  })
  .refine((row) => new Date(row.start).getTime() < new Date(row.end).getTime(), {
    message: 'end must be strictly after start',
    path: ['end'],
  })
  // Per-variant cross-field requirements. Linear has no extras; the
  // other three variants must supply their config columns or the proxy
  // would silently default to 1-day / 30-day shapes (which is what
  // earlier batch behaviour did — a real reviewer finding).
  .refine(
    (row) => row.vesting !== VestingMode.CliffLinear || row.cliffTime !== undefined,
    {
      message: 'cliffTime is required when vesting=CliffLinear',
      path: ['cliffTime'],
    },
  )
  .refine(
    (row) =>
      row.vesting !== VestingMode.Stepped ||
      (row.stepInterval !== undefined && row.amountPerStep !== undefined),
    {
      message: 'stepInterval AND amountPerStep are required when vesting=Stepped',
      path: ['stepInterval'],
    },
  )
  .refine(
    (row) => row.vesting !== VestingMode.RenewableTerm || row.termDuration !== undefined,
    {
      message: 'termDuration is required when vesting=RenewableTerm',
      path: ['termDuration'],
    },
  )
  .refine(
    (row) => {
      if (row.vesting !== VestingMode.CliffLinear || row.cliffTime === undefined) return true;
      const start = new Date(row.start).getTime();
      const end = new Date(row.end).getTime();
      const cliff = new Date(row.cliffTime).getTime();
      return start <= cliff && cliff < end;
    },
    {
      message: 'cliffTime must satisfy start ≤ cliffTime < end',
      path: ['cliffTime'],
    },
  );

export type BatchRow = z.infer<typeof batchRowSchema>;
