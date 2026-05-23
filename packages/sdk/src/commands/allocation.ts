/**
 * @module commands/allocation
 *
 * AllocationRequestV2 emission + Allocation_Settle dispatch (V2-only per STR-79).
 *
 * Per the V2-only architectural pivot (STR-79), V1 was dropped from this
 * library. The streaming primitive requires V2 committed-iterated
 * allocations; V1 has no iteration primitive that could serve the same role.
 * See STR-79 for the rationale + CIP-0112 §5 for the upstream backwards-
 * compatibility expectation (V1 assets are expected to publish V2 interfaces
 * alongside V1).
 *
 * This module is the SDK-side surface for exercising V2 AllocationRequest /
 * Allocation interfaces:
 *
 *   - `buildAllocationRequest(caps, params, templateId)` — construct an
 *     `AllocationRequestV2` create payload for a fresh stream (or the
 *     next withdrawal cycle of an existing one).
 *
 *   - `buildAllocationSettle(allocCid, …)` — wrap `Allocation_Settle`
 *     for the executor (escrow operator). Supports iterated settlement
 *     via `nextIterationFunding` (V2 primitive backing recurring streams).
 *
 *   - `buildAllocationCancel(allocCid)` — wrap `Allocation_Cancel`.
 *
 *   - `buildBatchSettlement(…)` — wrap `SettlementFactory_SettleBatch`
 *     for atomic multi-leg settlement (MilestoneEscrow, batched stream
 *     advancement).
 */

import Decimal from 'decimal.js';
import type { Logger } from 'pino';

import type { Transport, TemplateId } from '../transport/base.js';
import { type AssetCapabilities, assertActionSupported } from '../assets/capabilities.js';

// ---------------------------------------------------------------------------
// V2 allocation request types (wire-compatible with the stub Daml module in
// CantonStreams.Settlement.Stubs.AllocationRequestV2)
// ---------------------------------------------------------------------------

/**
 * V2 instrument id — `{ admin, id }`. Mirrors `Splice.Api.Token.HoldingV2.InstrumentId`.
 */
export interface InstrumentIdV2 {
  readonly admin: string;
  readonly id: string;
}

/**
 * V2 account — `{ owner?, provider?, id }`. Per the CIP-0112 update
 * (May 2026), `owner` is now `Optional Party` to support registry burn/mint
 * via ownerless accounts.
 */
export interface AccountV2 {
  readonly owner?: string | undefined;
  readonly provider?: string | undefined;
  readonly id: string;
}

/** Common settlement metadata. */
export type AllocationMetadata = Record<string, string>;

/**
 * Coordinates for a settlement. `executor` is the party authorized to
 * exercise `Allocation_Settle` (typically the escrow operator).
 */
export interface AllocationSettlementInfo {
  readonly executor: string;
  readonly settlementRefId: string;
  readonly requestedAt: Date;
  readonly allocateBefore?: Date | undefined;
  readonly settleBefore?: Date | undefined;
  readonly meta?: AllocationMetadata | undefined;
}

/**
 * A V2 transfer leg — recipient is a V2 `AccountV2`, addressed via the
 * V2 InstrumentId.
 */
export interface TransferLegV2 {
  readonly sender: string;
  readonly receiver: AccountV2;
  readonly amount: Decimal;
  readonly instrumentId: InstrumentIdV2;
  readonly meta?: AllocationMetadata | undefined;
}

/**
 * Parameters for `buildAllocationRequest`. The caller supplies the
 * `settlement` info and one or more `legs`.
 *
 * `originalRequestId` correlates a follow-on request (e.g. renewal,
 * counter-proposal) with a prior `AllocationRequest`. Per the spec author's
 * CIP-0112 update (May 2026), the V2 `AllocationRequestView` carries
 * `originalRequestId : Optional Text` so wallets + subscribers can
 * trace a request chain. STR-97.
 */
export interface BuildAllocationRequestParams {
  readonly settlement: AllocationSettlementInfo;
  readonly legs: ReadonlyArray<{
    readonly legId: string;
    readonly leg: TransferLegV2;
  }>;
  readonly meta?: AllocationMetadata | undefined;
  /** Prior AllocationRequest contract id this request originates from. */
  readonly originalRequestId?: string | undefined;
}

/**
 * Output of `buildAllocationRequest` — a create payload ready to be
 * submitted via the transport. `version` is always `'v2'` (kept as a
 * field so tests can assert it).
 */
export interface AllocationRequestPayload {
  readonly version: 'v2';
  readonly templateId: TemplateId;
  readonly argument: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helper: timestamp formatting
// ---------------------------------------------------------------------------

/** Daml Time wire format: `{ "timestamp": "<microseconds since epoch>" }`. */
function damlTimestamp(date: Date): { timestamp: string } {
  return { timestamp: (BigInt(date.getTime()) * 1000n).toString() };
}

/** Encode amounts as decimal-notation strings (no scientific notation). */
function damlNumeric(amount: Decimal | string | number): { numeric: string } {
  return { numeric: new Decimal(amount).toFixed(10) };
}

function metaToWire(meta: AllocationMetadata | undefined): Record<string, string> {
  return meta ?? {};
}

// ---------------------------------------------------------------------------
// Build AllocationRequestV2
// ---------------------------------------------------------------------------

/**
 * Construct an AllocationRequestV2 create payload.
 *
 * @param caps          Asset capabilities (asserted to support V2).
 * @param params        Settlement + legs + metadata.
 * @param templateId    TemplateId of the V2 AllocationRequest target on the ledger.
 */
export function buildAllocationRequest(
  caps: AssetCapabilities,
  params: BuildAllocationRequestParams,
  templateId: TemplateId,
): AllocationRequestPayload {
  const isMultiLeg = params.legs.length > 1;
  assertActionSupported(caps, isMultiLeg ? 'allocation-multi-leg' : 'allocation-single-leg');

  // Default settleBefore = allocateBefore + 5 minutes (matches the Daml
  // bridge default).
  const allocateBefore = params.settlement.allocateBefore ?? params.settlement.requestedAt;
  const settleBefore =
    params.settlement.settleBefore ?? new Date(allocateBefore.getTime() + 5 * 60 * 1000);

  const transferLegs: Record<string, Record<string, unknown>> = {};
  for (const { legId, leg } of params.legs) {
    transferLegs[legId] = {
      sender: { party: leg.sender },
      receiver: encodeAccountV2(leg.receiver),
      amount: damlNumeric(leg.amount),
      instrumentId: {
        admin: { party: leg.instrumentId.admin },
        id: { text: leg.instrumentId.id },
      },
      meta: metaToWire(leg.meta),
    };
  }

  const argument: Record<string, unknown> = {
    settlement: {
      executor: { party: params.settlement.executor },
      settlementRef: {
        id: { text: params.settlement.settlementRefId },
        contractRef: { optional: null },
      },
      requestedAt: damlTimestamp(params.settlement.requestedAt),
      allocateBefore: damlTimestamp(allocateBefore),
      settleBefore: damlTimestamp(settleBefore),
      meta: metaToWire(params.settlement.meta),
    },
    transferLegs,
    meta: metaToWire(params.meta),
    originalRequestId:
      params.originalRequestId !== undefined
        ? { optional: { text: params.originalRequestId } }
        : { optional: null },
  };

  return { version: 'v2', templateId, argument };
}

// ---------------------------------------------------------------------------
// V2 Allocation view (read-only projection — for SDK consumers reading state)
// ---------------------------------------------------------------------------

/**
 * Read-only projection of a V2 `AllocationView` from a queried allocation
 * contract. Used by SDK consumers that need to correlate allocations
 * across iterations.
 *
 * Per the CIP-0112 update (May 2026), `originalAllocationId` is
 * carried on the V2 `AllocationView` so subscribers + dApps can chain
 * iterated settlements (each iteration archives the prior allocation +
 * creates a new one referencing the original). STR-97.
 */
export interface AllocationView {
  readonly allocationCid: string;
  readonly settlementRefId: string;
  readonly amount: Decimal;
  readonly instrumentId: InstrumentIdV2;
  readonly executor: string;
  readonly committed: boolean;
  /** Numbering of the current iteration within an iterated chain (0 = initial). */
  readonly numIterations: number;
  /** Original AllocationRequest cid this allocation derives from. */
  readonly originalRequestId?: string | undefined;
  /**
   * Original Allocation cid for the FIRST iteration in the chain. Equal
   * to `allocationCid` for non-iterated allocations and for the first
   * iteration. Used by subscribers to correlate across the chain.
   */
  readonly originalAllocationId?: string | undefined;
}

/**
 * Encode a V2 Account per the CIP-0112 update.
 *
 *   - `owner : Optional Party` (None = ownerless / registry burn-mint)
 *   - `provider : Optional Party`
 *   - `id : Text` (use "" for default)
 */
function encodeAccountV2(acc: AccountV2): Record<string, unknown> {
  return {
    owner: acc.owner !== undefined
      ? { optional: { party: acc.owner } }
      : { optional: null },
    provider: acc.provider !== undefined
      ? { optional: { party: acc.provider } }
      : { optional: null },
    id: { text: acc.id },
  };
}

// ---------------------------------------------------------------------------
// Allocation_Settle dispatch
// ---------------------------------------------------------------------------

/**
 * V2 iterated-allocation funding. When provided to `buildAllocationSettle`,
 * the settle exercise refills funding for the next iteration — the V2
 * primitive that backs StreamFlow's recurring streams and per the spec author's
 * update powers prefunded trading.
 */
export interface NextIterationFunding {
  readonly amount: Decimal;
  /** Holding contract ids supplying the funding (wire-level identifiers). */
  readonly holdingCids: ReadonlyArray<string>;
  readonly nextSettleBefore: Date;
  readonly meta?: AllocationMetadata | undefined;
}

/**
 * Exercise `Allocation_Settle` against an existing AllocationV2 contract.
 */
export async function buildAllocationSettle(
  transport: Transport,
  caps: AssetCapabilities,
  allocationCid: string,
  templateId: TemplateId,
  actAs: string[],
  logger: Logger,
  opts?: { readonly nextIterationFunding?: NextIterationFunding },
): Promise<{ readonly version: 'v2'; readonly result: unknown }> {
  assertActionSupported(caps, 'allocation-single-leg');

  const nextWire = opts?.nextIterationFunding
    ? {
        optional: {
          amount: damlNumeric(opts.nextIterationFunding.amount),
          holdingCids: opts.nextIterationFunding.holdingCids.map((c) => ({ contractId: c })),
          nextSettleBefore: damlTimestamp(opts.nextIterationFunding.nextSettleBefore),
          meta: metaToWire(opts.nextIterationFunding.meta),
        },
      }
    : { optional: null };

  logger.info(
    { allocationCid, version: 'v2', iterated: !!opts?.nextIterationFunding },
    'Exercising Allocation_Settle (V2)',
  );
  const result = await transport.exercise(
    templateId,
    allocationCid,
    'Allocation_Settle',
    {
      nextIterationFunding: nextWire,
      extraArgs: emptyExtraArgsWire(),
    },
    actAs,
  );
  return { version: 'v2', result };
}

/**
 * Exercise `Allocation_Cancel` on an outstanding AllocationV2. Per V2
 * spec the choice is controlled by `actors` (typically the allocation
 * controllers).
 */
export async function buildAllocationCancel(
  transport: Transport,
  caps: AssetCapabilities,
  allocationCid: string,
  templateId: TemplateId,
  actAs: string[],
  logger: Logger,
): Promise<{ readonly version: 'v2'; readonly result: unknown }> {
  assertActionSupported(caps, 'allocation-single-leg');
  logger.info({ allocationCid, version: 'v2' }, 'Exercising Allocation_Cancel (V2)');
  const result = await transport.exercise(
    templateId,
    allocationCid,
    'Allocation_Cancel',
    { extraArgs: emptyExtraArgsWire() },
    actAs,
  );
  return { version: 'v2', result };
}

// ---------------------------------------------------------------------------
// V2: SettlementFactory_SettleBatch (multi-leg / multi-allocation)
// ---------------------------------------------------------------------------

/**
 * Build a multi-leg batch settlement exercise. Used by MilestoneEscrow
 * (STR-69) and by batched stream advancement (per the CIP-0112 prefunded
 * trading pattern: settle multiple committed allocations atomically).
 *
 * @param settlementFactoryCid SettlementFactory contract id on the ledger.
 * @param allocationCids       Per-leg-id → AllocationV2 contract id, all
 *                             referencing the same SettlementInfo.
 */
export async function buildBatchSettlement(
  transport: Transport,
  caps: AssetCapabilities,
  settlementFactoryCid: string,
  templateIdSettlementFactory: TemplateId,
  allocationCids: Readonly<Record<string, string>>,
  actAs: string[],
  logger: Logger,
): Promise<{ readonly version: 'v2'; readonly result: unknown }> {
  assertActionSupported(caps, 'allocation-batch');

  const allocationCidsWire: Record<string, { contractId: string }> = {};
  for (const [legId, cid] of Object.entries(allocationCids)) {
    allocationCidsWire[legId] = { contractId: cid };
  }

  logger.info(
    { settlementFactoryCid, legCount: Object.keys(allocationCids).length },
    'Exercising SettlementFactory_SettleBatch (V2)',
  );
  const result = await transport.exercise(
    templateIdSettlementFactory,
    settlementFactoryCid,
    'SettlementFactory_SettleBatch',
    {
      allocationCids: allocationCidsWire,
      extraArgs: emptyExtraArgsWire(),
    },
    actAs,
  );
  return { version: 'v2', result };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyExtraArgsWire(): Record<string, unknown> {
  return {
    context: { contextValues: {} },
    meta: {},
  };
}
