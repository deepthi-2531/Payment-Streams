/**
 * @module settlement/adapters/token-standard-v2
 *
 * CIP-56 V2 token-standard settlement adapter for the SDK (V2-only per STR-79).
 *
 * V1 was dropped from this library; see STR-79 for the rationale and
 * CIP-0112 §5 for the path back to V1-asset support (assets are expected
 * to publish V2 interfaces alongside V1 per the dual-implementation
 * normative requirement).
 *
 * The V2 adapter uses the V2 interfaces (HoldingV2, TransferInstructionV2,
 * AllocationV2, AllocationInstructionV2, AllocationRequestV2,
 * TransferEventsV2) and unlocks V2 features:
 *
 *   - lock-in-place custody (V2 `Holding.Lock`)
 *   - multi-leg `AllocationSpecification`
 *   - `SettlementFactory_SettleBatch` atomic batch settlement
 *   - `TransferEventsV2` event-driven advancement
 *
 * The Daml-side V2 adapter lives in
 * `packages/daml/main/daml/CantonStreams/Settlement/TokenStandardV2Adapter.daml`.
 *
 * **Status**: the V2 DARs are pinned to `canton-network/splice@token-standard-v2-upcoming`.
 * Until they are vetted and placed in `.lib/` (STR-42), this module
 * exports the type surfaces and dispatch metadata but defers concrete
 * V2 transfer calls to the per-protocol modules once V2 implementations
 * land. Callers should branch on `getAssetCapabilities` (STR-33)
 * rather than importing this module directly.
 */

import type { InstrumentIdV2, AccountV2 } from '../../types/stream.js';

// ---------------------------------------------------------------------------
// Stable identifier for adapter dispatch
// ---------------------------------------------------------------------------

/**
 * Stable identifier used by `selectAdapter` to dispatch into this
 * module when the chosen adapter is V2.
 */
export const ADAPTER_VERSION = 'v2' as const;

/**
 * CIP-56 V2 token-standard interface package ids that this adapter
 * targets. Used for ledger-side template-id construction.
 */
export const V2_INTERFACES = {
  holding: 'splice-api-token-holding-v2',
  transferInstruction: 'splice-api-token-transfer-instruction-v2',
  allocation: 'splice-api-token-allocation-v2',
  allocationInstruction: 'splice-api-token-allocation-instruction-v2',
  allocationRequest: 'splice-api-token-allocation-request-v2',
  transferEvents: 'splice-api-token-transfer-events-v2',
} as const;

// ---------------------------------------------------------------------------
// V2-specific request shapes (TypeScript mirrors of the V2 Daml types)
// ---------------------------------------------------------------------------

/**
 * A single leg in a V2 `AllocationSpecification`. V2 allows multi-leg
 * allocations in a single specification, so a batched settlement can
 * cover multiple stream advancements in one ledger event.
 */
export interface TransferLegV2 {
  readonly transferLegId: string;
  readonly sender: AccountV2;
  readonly receiver: AccountV2;
  readonly amount: string; // Decimal-as-string
  readonly instrumentId: InstrumentIdV2;
  readonly metaText?: string;
}

/**
 * V2 `AllocationSpecification`. Contains one or more transfer legs and
 * a settlement info envelope.
 */
export interface AllocationSpecificationV2 {
  readonly transferLegs: ReadonlyArray<TransferLegV2>;
  readonly executors: ReadonlyArray<string>;
  readonly settlementRef: string;
  readonly requestedAt: string;
  readonly settleAt: string;
  readonly settlementDeadline: string;
}

/**
 * V2 `Holding.Lock` parameters for lock-in-place custody.
 */
export interface HoldingLockV2 {
  readonly holders: ReadonlyArray<string>;
  readonly expiresAt?: string;
  readonly expiresAfter?: string;
  readonly context?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildAdvancementLeg(
  legId: string,
  sender: AccountV2,
  receiver: AccountV2,
  amount: string,
  instrumentId: InstrumentIdV2,
  metaText?: string,
): TransferLegV2 {
  return {
    transferLegId: legId,
    sender,
    receiver,
    amount,
    instrumentId,
    ...(metaText !== undefined ? { metaText } : {}),
  };
}

export function buildPrefundedStreamLock(
  recipient: string,
  escrowOperator: string,
  streamEnd: string,
  streamIdText: string,
): HoldingLockV2 {
  return {
    holders: [recipient, escrowOperator],
    expiresAt: streamEnd,
    context: `canton-streams: prefunded stream ${streamIdText}`,
  };
}
