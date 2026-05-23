/**
 * Stream creation commands.
 *
 * Dispatches to the correct template based on settlementMode:
 * - NumericLegacy: CreateStreamRequest (Phase 1 numeric escrow)
 * - UtilityHoldingCustody: CreateUtilityHoldingStreamRequest (Phase 2)
 * - TokenStandardCustody: CreateTokenStandardStreamRequest (Phase 2 external-token custody)
 * - LocalAssetCustody: CreateLocalAssetStreamRequest (Phase 2, spike-first)
 *
 * @module commands/create
 */

import type { Transport } from '../transport/base.js';
import type {
  CreateStreamParams,
  CreateBatchParams,
  InstrumentRef,
  VestingModeConfig,
} from '../types/stream.js';
import { VestingMode, AssetType, SettlementMode } from '../types/stream.js';
import { CreateStreamParamsSchema, validate } from '../utils/validation.js';
import {
  TEMPLATE_CREATE_REQUEST,
  TEMPLATE_UTILITY_CREATE_REQUEST,
  TEMPLATE_TOKEN_STANDARD_CREATE_REQUEST,
  TEMPLATE_LOCAL_ASSET_CREATE_REQUEST,
  assertTokenStandardEscrowAvailable,
} from '../templates.js';
import type { Logger } from 'pino';

/**
 * Create a single payment stream.
 *
 * 1. Validates input params
 * 2. Generates streamId if not provided
 * 3. Creates a CreateStreamRequest on-ledger
 * 4. Returns the pending request (recipient must accept to create StreamHoldingEscrow)
 *
 * The CreateStreamRequest carries:
 *   - config: StreamConfig with all vesting parameters
 *   - deposit: HoldingEscrow referencing the actual Daml Finance holding
 *   - fundingHoldingCid: the real holding to carve into escrow
 */
export async function createStream(
  transport: Transport,
  params: CreateStreamParams,
  actAs: string[],
  logger: Logger,
): Promise<{ requestContractId: string; streamId: string }> {
  // Zod's record inference returns Record<string, unknown>; cast to our stricter type.
  const validated = validate(CreateStreamParamsSchema, params) as unknown as CreateStreamParams;
  const streamId = validated.streamId || generateStreamId();

  assertActAsIncludesSender(actAs, validated.sender);

  const settlementMode = validated.settlementMode ?? SettlementMode.UtilityHoldingCustody;
  const createParams: CreateStreamParams = { ...validated, settlementMode };
  logger.info({ streamId, recipient: validated.recipient, settlementMode }, 'Creating stream request');

  let result;

  switch (settlementMode) {
    case SettlementMode.UtilityHoldingCustody: {
      // Phase 2: Utility/CIP custody — three-step creation
      if (!validated.holdingCid) throw new Error('holdingCid required for UtilityHoldingCustody');
      if (!validated.instrumentRef) throw new Error('instrumentRef required for UtilityHoldingCustody');
      if (!validated.escrowOperator) throw new Error('escrowOperator required for UtilityHoldingCustody');

      result = await transport.create(
        TEMPLATE_UTILITY_CREATE_REQUEST,
        {
          config: serializeStreamConfig(streamId, validated.sender, createParams),
          fundingHoldingCid: { contract_id: validated.holdingCid },
          depositAmount: { numeric: validated.totalDeposited.toString() },
          escrowOperator: { party: validated.escrowOperator },
          observers: [],
        },
        actAs,
      );
      break;
    }

    case SettlementMode.TokenStandardCustody: {
      // [C1 fix — STR-103] TokenStandardEscrow Daml template missing.
      assertTokenStandardEscrowAvailable();
      if (!validated.fundingReference) throw new Error('fundingReference required for TokenStandardCustody');
      if (!validated.instrumentRef) throw new Error('instrumentRef required for TokenStandardCustody');
      if (!validated.escrowOperator) throw new Error('escrowOperator required for TokenStandardCustody');
      if (!validated.senderAccount) throw new Error('senderAccount required for TokenStandardCustody');
      if (!validated.recipientAccount) throw new Error('recipientAccount required for TokenStandardCustody');

      result = await transport.create(
        TEMPLATE_TOKEN_STANDARD_CREATE_REQUEST,
        {
          config: serializeStreamConfig(streamId, validated.sender, createParams),
          depositAmount: { numeric: validated.totalDeposited.toString() },
          escrowOperator: { party: validated.escrowOperator },
          fundingReference: { text: validated.fundingReference },
          senderAccountRef: { text: JSON.stringify(validated.senderAccount) },
          recipientAccountRef: { text: JSON.stringify(validated.recipientAccount) },
          observers: [],
        },
        actAs,
      );
      break;
    }

    case SettlementMode.LocalAssetCustody: {
      // Phase 2: Local asset custody — three-step creation (AMM AssetHolding)
      if (!validated.holdingCid) throw new Error('holdingCid required for LocalAssetCustody');
      if (!validated.escrowOperator) throw new Error('escrowOperator required for LocalAssetCustody');
      if (!validated.recipientAccount) throw new Error('recipientAccount required for LocalAssetCustody');

      result = await transport.create(
        TEMPLATE_LOCAL_ASSET_CREATE_REQUEST,
        {
          config: serializeStreamConfig(streamId, validated.sender, createParams),
          fundingHoldingCid: { contract_id: validated.holdingCid },
          depositAmount: { numeric: validated.totalDeposited.toString() },
          escrowOperator: { party: validated.escrowOperator },
          recipientAccount: validated.recipientAccount,
          observers: [],
        },
        actAs,
      );
      break;
    }

    case SettlementMode.NumericLegacy: {
      // Phase 1: Numeric escrow — simple bookkeeping escrow (no real holdings)
      result = await transport.create(
        TEMPLATE_CREATE_REQUEST,
        {
          config: serializeStreamConfig(streamId, validated.sender, createParams),
          depositAmount: { numeric: validated.totalDeposited.toString() },
          observers: [],
        },
        actAs,
      );
      break;
    }

    case SettlementMode.Delegated:
      // Phase 3 Delegated mode is documented in the SettlementMode enum but
      // has no V2-only on-ledger implementation — the V2-only pivot (STR-79)
      // collapses delegated semantics into Token-Standard executor auth on
      // the AllocationV2 contracts. Reject explicitly so callers know to
      // model their flow with TokenStandardCustody + a delegated executor
      // party rather than this dead enum variant.
      throw new Error(
        'SettlementMode.Delegated is not supported in V2-only library; ' +
        'use TokenStandardCustody with a delegated executor party. See STR-79.',
      );

    default:
      throw new Error(`Unsupported settlementMode: ${settlementMode satisfies never}`);
  }

  logger.info({ streamId, contractId: result.contractId, settlementMode }, 'Stream request created');

  return {
    requestContractId: result.contractId,
    streamId,
  };
}

/**
 * Create multiple streams in a single batch transaction.
 *
 * Each stream in the batch is created as an individual CreateUtilityHoldingStreamRequest
 * (or LocalAssetStreamRequest, depending on settlementMode). This preserves the
 * three-step custody workflow (create → accept → finalize) for each stream while
 * allowing callers to submit them in a single SDK call.
 *
 * The batch itself is an SDK-level convenience — each stream request is an
 * independent on-ledger contract that the recipient must accept individually.
 */
export async function createBatch(
  transport: Transport,
  params: CreateBatchParams,
  actAs: string[],
  logger: Logger,
): Promise<{ batchContractId: string; streamIds: string[] }> {
  if (!params.streams || params.streams.length === 0) {
    throw new Error('Batch must contain at least one stream');
  }

  logger.info({ count: params.streams.length }, 'Creating batch of stream requests');

  const streamIds: string[] = [];
  const contractIds: string[] = [];

  for (const streamParams of params.streams) {
    const result = await createStream(transport, streamParams, actAs, logger);
    streamIds.push(result.streamId);
    contractIds.push(result.requestContractId);
  }

  logger.info({ count: streamIds.length, streamIds }, 'Batch creation complete');

  return {
    batchContractId: contractIds[0] ?? '', // First contract ID as batch reference
    streamIds,
  };
}

function generateStreamId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Serialization helpers — Ledger API Value encoding
// ---------------------------------------------------------------------------

/**
 * Serialize StreamConfig fields for the Ledger API.
 *
 * Daml types → Ledger API Value mapping:
 *   Party → party (string)
 *   Text → text (string)
 *   Decimal → numeric (string representation)
 *   Time → timestamp (microseconds since epoch, as int64 string)
 *   Bool → bool
 *   VestingMode → variant
 */
function serializeStreamConfig(
  streamId: string,
  sender: string,
  params: CreateStreamParams,
): Record<string, unknown> {
  return {
    streamId: { text: streamId },
    sender: { party: sender },
    recipient: { party: params.recipient },
    totalDeposited: { numeric: params.totalDeposited.toString() },
    startTime: { timestamp: dateToLedgerTime(params.startTime) },
    endTime: { timestamp: dateToLedgerTime(params.endTime) },
    vestingMode: serializeVestingMode(params.vestingMode),
    assetType: serializeAssetType(params.assetType ?? AssetType.GlobalCip56),
    instrumentRef: serializeInstrumentRef(params.instrumentRef),
    cancellable: { bool: params.cancellable },
    settlementMode: serializeOptionalSettlementMode(params.settlementMode),
  };
}

/**
 * Convert a JS Date to Daml Time for Ledger API.
 *
 * Daml Time is microseconds since Unix epoch. The gRPC Ledger API v2
 * represents timestamps as google.protobuf.Timestamp (seconds + nanos),
 * but proto-loader with longs=String serializes them as ISO strings or
 * epoch values depending on the encoding path.
 *
 * We encode as microseconds-since-epoch string, which the transport
 * layer's encodeValue will wrap in the appropriate timestamp Value.
 */
function dateToLedgerTime(date: Date): string {
  // Date.getTime() is milliseconds; Daml Time is microseconds
  return (BigInt(date.getTime()) * 1000n).toString();
}

/**
 * Serialize a VestingModeConfig to match Daml variant constructors.
 *
 * Daml Types.daml defines:
 *   Linear
 *   CliffLinear with cliffTime : Time
 *   Stepped with stepInterval : RelTime; amountPerStep : Decimal
 *   RenewableTerm with termDuration : RelTime
 *
 * Each is encoded as { tag, value } which the transport encodeValue
 * maps to a Ledger API Variant message.
 *
 * Field types:
 *   Time → timestamp (microseconds since epoch string)
 *   RelTime → int64 (microseconds string)
 *   Decimal → numeric (string)
 */
function serializeVestingMode(config: VestingModeConfig): Record<string, unknown> {
  switch (config.mode) {
    case VestingMode.Linear:
      return { tag: 'Linear', value: {} };
    case VestingMode.CliffLinear:
      return {
        tag: 'CliffLinear',
        value: { cliffTime: { timestamp: dateToLedgerTime(config.cliffTime) } },
      };
    case VestingMode.Stepped:
      return {
        tag: 'Stepped',
        value: {
          stepInterval: { int64: config.stepInterval.toString() },
          amountPerStep: { numeric: config.amountPerStep.toString() },
        },
      };
    case VestingMode.RenewableTerm:
      return {
        tag: 'RenewableTerm',
        value: { termDuration: { int64: config.termDuration.toString() } },
      };
  }
}

function serializeSettlementMode(mode: SettlementMode): Record<string, unknown> {
  // SettlementMode is a Daml enum (no data fields)
  switch (mode) {
    case SettlementMode.NumericLegacy:
      return { enum: { enum_constructor: 'NumericLegacy' } };
    case SettlementMode.UtilityHoldingCustody:
      return { enum: { enum_constructor: 'UtilityHoldingCustody' } };
    case SettlementMode.TokenStandardCustody:
      return { enum: { enum_constructor: 'TokenStandardCustody' } };
    case SettlementMode.LocalAssetCustody:
      return { enum: { enum_constructor: 'LocalAssetCustody' } };
    case SettlementMode.Delegated:
      return { enum: { enum_constructor: 'Delegated' } };
    default:
      return { enum: { enum_constructor: 'NumericLegacy' } };
  }
}

function serializeOptionalSettlementMode(mode: SettlementMode | undefined): Record<string, unknown> {
  // settlementMode was added after v0.1.0. Encode NumericLegacy/default as None so
  // the field can be safely dropped when interacting with older deployments.
  if (!mode || mode === SettlementMode.NumericLegacy) {
    return { optional: null };
  }

  return { optional: serializeSettlementMode(mode) };
}

function serializeAssetType(assetType: AssetType): Record<string, unknown> {
  // AssetType is a Daml enum (no data fields) — use enum encoding, not variant
  switch (assetType) {
    case AssetType.ValidatorLocalAsset:
      return { enum: { enum_constructor: 'LocalToken' } };
    case AssetType.LocalCip56:
      return { enum: { enum_constructor: 'LocalHolding' } };
    case AssetType.GlobalCip56:
      return { enum: { enum_constructor: 'GlobalHolding' } };
  }
}

/**
 * Serialize an Optional InstrumentRef for the Ledger API.
 *
 * Daml Optional is encoded as a variant: { tag: 'Some', value: ... } or { tag: 'None', value: {} }.
 * InstrumentRef record: { depository : Party, issuer : Party, instrumentId : Text, instrumentVersion : Text }
 */
function serializeInstrumentRef(ref: InstrumentRef | undefined): Record<string, unknown> {
  if (!ref) {
    // Daml Optional None → Ledger API Value.optional with no value
    return { optional: null };
  }
  // Daml Optional Some → Ledger API Value.optional with a record value
  return {
    optional: {
      record: {
        fields: [
          { label: 'depository', value: { party: ref.depository } },
          { label: 'issuer', value: { party: ref.issuer } },
          { label: 'instrumentId', value: { text: ref.instrumentId } },
          { label: 'instrumentVersion', value: { text: ref.instrumentVersion } },
        ],
      },
    },
  };
}

function assertActAsIncludesSender(actAs: string[], sender: string): void {
  if (!actAs.includes(sender)) {
    throw new Error(`actAs must include sender party "${sender}"`);
  }
}
