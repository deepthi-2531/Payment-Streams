/**
 * @module lib/schemas/createStreamV1
 *
 * Zod schema for the V1 "Create stream" form (proxy /api/v1/streams).
 *
 * The V1 lane is the proven token-standard direct-delivery flow: the payer
 * accrues `ratePerCycle` per cadence period and each `settle` draws one
 * cycle from the payer's wallet (no funding lock at create time). The form
 * therefore needs far fewer fields than the V2 wizard — recipient, rate,
 * cadence, an optional stream id, and a couple of optional knobs.
 *
 * `payerParty` is NOT a form field: it is always the connected wallet's
 * party (the proxy requires caller === payerParty), so the form injects it
 * at submit time rather than letting the user type it.
 */

import { z } from 'zod';

/**
 * Party identifier — `Hint::namespace-fingerprint`. Matches the V2 schema's
 * permissive check (non-empty + `::` separator) rather than a tight regex,
 * because the Canton party-id grammar is broader than a regex captures.
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

export const createStreamV1Schema = z.object({
  /** Optional explicit id; proxy auto-generates `v1-<ts>-<rand>` when blank. */
  streamId: z
    .string()
    .trim()
    .max(120, 'Stream id is too long')
    .optional()
    .or(z.literal('')),
  recipientParty: partyIdSchema,
  /**
   * Whitelisted asset key from GET /api/assets (e.g. 'cc', 'usdcx'). Blank or
   * absent ⇒ the proxy defaults to Canton Coin. Only whitelisted keys are
   * accepted server-side, so no free-text validation is needed here.
   */
  assetKey: z.string().trim().max(64, 'Asset key is too long').optional().or(z.literal('')),
  /** Accrued per cadence period; aliased to `ratePerCycle` on the wire. */
  ratePerCycle: decimalStringSchema,
  cadence: z.enum(['second', 'minute', 'hourly', 'daily']),
  arrearsPolicy: z.enum(['catch-up', 'skip-missed']),
  /** Optional app id stamped on each transfer (cantonstreams.dev/app). */
  appId: z
    .string()
    .trim()
    .max(120, 'App id is too long')
    .optional()
    .or(z.literal('')),
});

export type CreateStreamV1Values = z.infer<typeof createStreamV1Schema>;
