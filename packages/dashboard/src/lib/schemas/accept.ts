/**
 * @module lib/schemas/accept
 *
 * Zod schema for the Accept Stream modal. The recipient accepts an
 * incoming `CreateStreamRequest` contract. For most settlement modes
 * the only input is consent — but TokenStandardCustody acceptance
 * still requires the recipient's wallet account binding so the
 * downstream finalize can route the transfer.
 */

import { z } from 'zod';
import { SettlementMode } from '@canton-streams/sdk/browser';

export const acceptSchema = z.discriminatedUnion('settlementMode', [
  z.object({
    settlementMode: z.literal(SettlementMode.NumericLegacy),
    contractId: z.string().min(1),
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.UtilityHoldingCustody),
    contractId: z.string().min(1),
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.LocalAssetCustody),
    contractId: z.string().min(1),
    recipientAccount: z.string().min(1),
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.TokenStandardCustody),
    contractId: z.string().min(1),
    recipientAccount: z.string().min(1),
  }).refine(() => false, {
    message:
      'TokenStandardCustody accept not available — Daml template missing ' +
      '(STR-103). Track lifecycle migration in STR-86.',
  }),
  z.object({
    settlementMode: z.literal(SettlementMode.Delegated),
    contractId: z.string().min(1),
  }),
]);

export type AcceptSchemaValues = z.infer<typeof acceptSchema>;
