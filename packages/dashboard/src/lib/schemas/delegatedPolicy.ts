/**
 * @module lib/schemas/delegatedPolicy
 *
 * Zod schema for the Create Delegated Policy form. Mirrors
 * `CantonStreams.Policy.DelegatedPolicy` Daml template fields.
 */

import { z } from 'zod';

const partyIdSchema = z
  .string()
  .min(3)
  .refine((p) => p.includes('::'), {
    message: 'Party identifier must contain `::`',
  });

const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal');

/** DelegatedAction enum from the Daml template. */
export const delegatedActionSchema = z.enum(['withdraw', 'cancel', 'renew']);

export const rateLimitSchema = z.object({
  maxExecutionsPerPeriod: z.number().int().positive(),
  periodDuration: z.number().int().positive(),
  maxAmountPerExecution: decimalStringSchema,
  cooldownInterval: z.number().int().nonnegative(),
});

export const delegatedPolicySchema = z
  .object({
    policyId: z.string().min(1),
    sender: partyIdSchema,
    recipient: partyIdSchema,
    executor: partyIdSchema,
    allowedActions: z
      .array(delegatedActionSchema)
      .min(1, 'At least one allowed action must be selected'),
    streamFilters: z.array(z.string()).default([]),
    rateLimit: rateLimitSchema,
    expiresAt: z
      .string()
      .min(1)
      .refine((s) => !Number.isNaN(new Date(s).getTime()), {
        message: 'Invalid expiry timestamp',
      }),
  })
  .refine(
    (p) => new Date(p.expiresAt).getTime() > Date.now(),
    {
      message: 'expiresAt must be in the future',
      path: ['expiresAt'],
    },
  )
  .refine((p) => p.sender !== p.executor, {
    message: 'sender and executor must be different parties',
    path: ['executor'],
  });

export type DelegatedPolicySchemaValues = z.infer<typeof delegatedPolicySchema>;
