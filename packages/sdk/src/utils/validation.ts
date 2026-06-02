/**
 * @module utils/validation
 *
 * Zod schemas for client-side input validation.
 * All validation runs *before* any ledger round-trip to fail fast.
 *
 * Schema shapes match the Daml Types.daml contract model exactly.
 */

import { z } from 'zod';
import Decimal from 'decimal.js';
import { AssetType, VestingMode, StreamStatus, SettlementMode } from '../types/stream.js';
import { ValidationError } from './errors.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Schema that accepts a Decimal instance and asserts it is positive. */
const positiveDecimal = z.custom<Decimal>(
  (val) => val instanceof Decimal && val.isPositive() && !val.isZero(),
  { message: 'Must be a positive Decimal (> 0)' },
);

/** Schema for a non-empty trimmed string (e.g. party identifiers). */
const nonEmptyString = z.string().trim().min(1, 'Must be a non-empty string');

/** Schema for JSON-like ledger record values used by account keys. */
const ledgerRecordValue: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(ledgerRecordValue),
    z.record(z.string(), ledgerRecordValue),
  ]),
);

/** Schema for account-key-like ledger records. */
const ledgerRecordSchema = z
  .record(z.string(), ledgerRecordValue)
  .refine((value) => Object.keys(value).length > 0, 'Must be a non-empty record');

/** Schema for a stream ID: non-empty, no whitespace, max 256 chars. */
const streamIdSchema = z
  .string()
  .trim()
  .min(1, 'streamId must not be empty')
  .max(256, 'streamId must be at most 256 characters')
  .regex(/^\S+$/, 'streamId must not contain whitespace');

// ---------------------------------------------------------------------------
// Vesting mode config schemas (matching Daml Types.daml)
// ---------------------------------------------------------------------------

const linearConfigSchema = z.object({
  mode: z.literal(VestingMode.Linear),
});

/** CliffLinear: only cliffTime (no cliffAmount — matches Daml). */
const cliffLinearConfigSchema = z.object({
  mode: z.literal(VestingMode.CliffLinear),
  cliffTime: z.date(),
});

/**
 * Stepped: stepInterval (microseconds) + amountPerStep.
 * Matches Daml: `Stepped with stepInterval : RelTime; amountPerStep : Decimal`
 */
const steppedConfigSchema = z.object({
  mode: z.literal(VestingMode.Stepped),
  stepInterval: z.number().int().positive('stepInterval must be > 0'),
  amountPerStep: positiveDecimal,
});

/**
 * RenewableTerm: termDuration (microseconds).
 * Matches Daml: `RenewableTerm with termDuration : RelTime`
 */
const renewableTermConfigSchema = z.object({
  mode: z.literal(VestingMode.RenewableTerm),
  termDuration: z.number().int().positive('termDuration must be > 0'),
});

const vestingModeConfigSchema = z.discriminatedUnion('mode', [
  linearConfigSchema,
  cliffLinearConfigSchema,
  steppedConfigSchema,
  renewableTermConfigSchema,
]);

// ---------------------------------------------------------------------------
// InstrumentRef schema
// ---------------------------------------------------------------------------

/**
 * Schema for InstrumentRef — references a Daml Finance instrument.
 * Matches Daml: `InstrumentRef with depository : Party; issuer : Party;
 *   instrumentId : Text; instrumentVersion : Text`
 */
const instrumentRefSchema = z.object({
  depository: nonEmptyString,
  issuer: nonEmptyString,
  instrumentId: nonEmptyString,
  instrumentVersion: nonEmptyString,
});

// ---------------------------------------------------------------------------
// CreateStreamParams schema
// ---------------------------------------------------------------------------

/**
 * Schema for {@link CreateStreamParams}.
 *
 * Cross-field validations:
 * - `startTime` must be strictly before `endTime`.
 * - For CliffLinear: `cliffTime` must be between `startTime` and `endTime`.
 * - For Stepped: `stepInterval` must be > 0 and `amountPerStep` must be > 0.
 * - `sender` must differ from `recipient`.
 */
export const CreateStreamParamsSchema = z
  .object({
    streamId: streamIdSchema,
    sender: nonEmptyString,
    recipient: nonEmptyString,
    totalDeposited: positiveDecimal,
    startTime: z.date(),
    endTime: z.date(),
    vestingMode: vestingModeConfigSchema,
    assetType: z.nativeEnum(AssetType).optional(),
    instrumentRef: instrumentRefSchema.optional(),
    holdingCid: nonEmptyString.optional(),
    fundingReference: nonEmptyString.optional(),
    senderAccount: ledgerRecordSchema.optional(),
    recipientAccount: ledgerRecordSchema.optional(),
    cancellable: z.boolean(),
    settlementMode: z.nativeEnum(SettlementMode).optional(),
    escrowOperator: nonEmptyString.optional(),
  })
  .superRefine((data, ctx) => {
    // startTime < endTime
    if (data.startTime.getTime() >= data.endTime.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endTime'],
        message: 'endTime must be strictly after startTime',
      });
    }

    // sender !== recipient
    if (data.sender === data.recipient) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipient'],
        message: 'recipient must differ from sender',
      });
    }

    const assetType = data.assetType ?? AssetType.GlobalCip56;
    const settlementMode = data.settlementMode ?? SettlementMode.TokenStandardCustody;

    if (settlementMode !== SettlementMode.TokenStandardCustody) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['settlementMode'],
        message: 'New streams are V2-only. Use TokenStandardCustody with a CIP-56 V2 asset.',
      });
    }

    if (
      settlementMode === SettlementMode.UtilityHoldingCustody &&
      assetType === AssetType.ValidatorLocalAsset
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetType'],
        message: 'Validator-local assets require LocalAssetCustody settlement.',
      });
    }

    if (
      settlementMode === SettlementMode.TokenStandardCustody &&
      assetType === AssetType.ValidatorLocalAsset
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetType'],
        message: 'Validator-local assets require LocalAssetCustody settlement.',
      });
    }

    if (
      settlementMode === SettlementMode.LocalAssetCustody &&
      assetType !== AssetType.ValidatorLocalAsset
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetType'],
        message: 'LocalAssetCustody requires the ValidatorLocalAsset asset type.',
      });
    }

    // instrumentRef requirements depend on both assetType AND settlementMode:
    // - New stream creation uses holding-backed settlement by default
    // - Custody modes require instrumentRef for CIP-56 asset types
    const isCustodyMode =
      settlementMode === SettlementMode.UtilityHoldingCustody ||
      settlementMode === SettlementMode.TokenStandardCustody ||
      settlementMode === SettlementMode.LocalAssetCustody;

    if (isCustodyMode) {
      const requiresInstrumentRef =
        assetType === AssetType.LocalCip56 || assetType === AssetType.GlobalCip56;

      if (requiresInstrumentRef && !data.instrumentRef) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['instrumentRef'],
          message:
            'instrumentRef is required for CIP-56 asset types in custody-backed settlement modes',
        });
      }
    }

    if (assetType === AssetType.ValidatorLocalAsset && data.instrumentRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instrumentRef'],
        message: 'instrumentRef is only supported for CIP-56 asset modes',
      });
    }

    // Settlement-mode-specific cross-field checks (holdingCid, escrowOperator)
    if (
      settlementMode === SettlementMode.UtilityHoldingCustody ||
      settlementMode === SettlementMode.LocalAssetCustody
    ) {
      if (!data.holdingCid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['holdingCid'],
          message: 'holdingCid is required for custody-backed settlement modes',
        });
      }
      if (!data.escrowOperator) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['escrowOperator'],
          message: 'escrowOperator is required for custody-backed settlement modes',
        });
      }
    }

    if (settlementMode === SettlementMode.LocalAssetCustody && !data.recipientAccount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipientAccount'],
        message: 'recipientAccount is required for local-asset custody',
      });
    }

    if (settlementMode === SettlementMode.TokenStandardCustody) {
      if (!data.escrowOperator) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['escrowOperator'],
          message: 'escrowOperator is required for token-standard custody',
        });
      }
      if (!data.fundingReference) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fundingReference'],
          message: 'fundingReference is required for token-standard custody',
        });
      }
      if (!data.senderAccount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['senderAccount'],
          message: 'senderAccount is required for token-standard custody',
        });
      }
      if (!data.recipientAccount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recipientAccount'],
          message: 'recipientAccount is required for token-standard custody',
        });
      }
      if (data.holdingCid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['holdingCid'],
          message: 'holdingCid is not used in TokenStandardCustody mode',
        });
      }
    }

    if (settlementMode === SettlementMode.NumericLegacy && data.holdingCid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['holdingCid'],
        message: 'holdingCid is not used in NumericLegacy mode',
      });
    }
    if (settlementMode === SettlementMode.NumericLegacy && data.fundingReference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fundingReference'],
        message: 'fundingReference is not used in NumericLegacy mode',
      });
    }

    // CliffLinear-specific
    if (data.vestingMode.mode === VestingMode.CliffLinear) {
      const cfg = data.vestingMode;
      if (
        cfg.cliffTime.getTime() <= data.startTime.getTime() ||
        cfg.cliffTime.getTime() >= data.endTime.getTime()
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vestingMode', 'cliffTime'],
          message: 'cliffTime must be between startTime and endTime (exclusive)',
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// RenewParams schema
// ---------------------------------------------------------------------------

/** Schema for {@link RenewParams}. */
export const RenewParamsSchema = z
  .object({
    additionalAmount: positiveDecimal,
    newEndTime: z.date(),
    holdingCid: nonEmptyString.optional(),
    senderAccount: ledgerRecordSchema.optional(),
    fundingReference: nonEmptyString.optional(),
    settlementReference: nonEmptyString.optional(),
    confirmedAdditionalAmount: positiveDecimal.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.newEndTime.getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newEndTime'],
        message: 'newEndTime must be in the future',
      });
    }
  });

// ---------------------------------------------------------------------------
// StreamFilter schema
// ---------------------------------------------------------------------------

/** Schema for {@link StreamFilter}. */
export const StreamFilterSchema = z.object({
  sender: nonEmptyString.optional(),
  recipient: nonEmptyString.optional(),
  status: z.nativeEnum(StreamStatus).optional(),
  vestingMode: z.nativeEnum(VestingMode).optional(),
  settlementMode: z.nativeEnum(SettlementMode).optional(),
});

// ---------------------------------------------------------------------------
// validate() helper
// ---------------------------------------------------------------------------

/**
 * Validate an input value against a Zod schema.
 * Throws a {@link ValidationError} on failure with the first issue's path and message.
 *
 * @param schema - Zod schema to validate against.
 * @param value  - The value to validate.
 * @returns The parsed (and possibly transformed) value.
 * @throws {ValidationError} When validation fails.
 */
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const firstIssue = result.error.issues[0];
  const field = firstIssue?.path?.join('.') || undefined;
  const details = firstIssue?.message;
  throw new ValidationError(
    `Validation failed${field ? ` on field "${field}"` : ''}: ${details}`,
    field,
    details,
  );
}
