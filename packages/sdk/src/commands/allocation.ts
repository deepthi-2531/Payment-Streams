/**
 * @module commands/allocation
 *
 * AllocationRequestV2 emission + Allocation_Settle dispatch.
 *
 * The streaming primitive requires V2 committed-iterated allocations;
 * V1 has no iteration primitive that could serve the same role. Per
 * CIP-0112 §5, V1 assets are expected to publish V2 interfaces alongside V1.
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
// V2 allocation request types (wire-compatible with the published
// Splice.Api.Token.* V2 interfaces)
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

/** Coordinates for a settlement. `executors` are authorized to settle/cancel. */
export interface AllocationSettlementInfo {
  /** V2-standard executor list. */
  readonly executors?: ReadonlyArray<string> | undefined;
  /** @deprecated Use `executors`; kept as a compatibility shim for callers. */
  readonly executor: string;
  readonly settlementRefId: string;
  /** Optional contract-id based settlement reference (`SettlementInfo.cid`). */
  readonly settlementRefCid?: string | undefined;
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
  /**
   * Deprecated party shorthand for the authorizer account. If `authorizer`
   * is omitted this becomes `Account { owner = Some sender, provider = None, id = "" }`.
   */
  readonly sender: string;
  /** V2 allocation authorizer account. */
  readonly authorizer?: AccountV2 | undefined;
  readonly receiver: AccountV2;
  readonly amount: Decimal;
  readonly instrumentId: InstrumentIdV2;
  readonly side?: 'SenderSide' | 'ReceiverSide' | undefined;
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
 * trace a request chain.
 */
export interface BuildAllocationRequestParams {
  readonly settlement: AllocationSettlementInfo;
  readonly legs: ReadonlyArray<{
    readonly legId: string;
    readonly leg: TransferLegV2;
  }>;
  /** If true, the authorizer cannot withdraw before the settlement deadline. */
  readonly committed?: boolean | undefined;
  /** Initial iterated-settlement funding, keyed by V2 instrument id text. */
  readonly nextIterationFunding?: NextIterationFundingAmounts | undefined;
  readonly meta?: AllocationMetadata | undefined;
  /** Prior AllocationRequest contract id this request originates from. */
  readonly originalRequestCid?: string | undefined;
  /** @deprecated Use `originalRequestCid`; retained for callers from the stub era. */
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

function optionalWire(value: unknown | undefined): { optional: unknown | null } {
  return value !== undefined ? { optional: value } : { optional: null };
}

function textMapWire(
  values: Readonly<Record<string, unknown>> | undefined,
): { text_map: { entries: Array<{ key: string; value: unknown }> } } {
  return {
    text_map: {
      entries: Object.entries(values ?? {}).map(([key, value]) => ({ key, value })),
    },
  };
}

function decimalTextMapWire(
  values: NextIterationFundingAmounts | undefined,
): { text_map: { entries: Array<{ key: string; value: { numeric: string } }> } } {
  return {
    text_map: {
      entries: Object.entries(values ?? {}).map(([key, value]) => ({
        key,
        value: damlNumeric(value),
      })),
    },
  };
}

function metaToWire(meta: AllocationMetadata | undefined): Record<string, unknown> {
  const textValues = Object.fromEntries(
    Object.entries(meta ?? {}).map(([key, value]) => [key, { text: value }]),
  );
  return { values: textMapWire(textValues) };
}

function damlVariant(variantConstructor: string, value: unknown = { unit: {} }): Record<string, unknown> {
  return {
    variant: {
      variant_constructor: variantConstructor,
      value,
    },
  };
}

function genMapWire(
  entries: Array<{ key: unknown; value: unknown }>,
): { gen_map: { entries: Array<{ key: unknown; value: unknown }> } } {
  return { gen_map: { entries } };
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

  const settlementDeadline = params.settlement.settleBefore ?? settleBefore;
  const committed = params.committed ?? true;
  const allocations = params.legs.map(({ legId, leg }) => ({
    admin: { party: leg.instrumentId.admin },
    authorizer: encodeAccountV2(leg.authorizer ?? { owner: leg.sender, id: '' }),
    transferLegSides: [
      encodeTransferLegSide(legId, leg),
    ],
    settlementDeadline: optionalWire(damlTimestamp(settlementDeadline)),
    nextIterationFunding: optionalWire(
      params.nextIterationFunding !== undefined
        ? decimalTextMapWire(params.nextIterationFunding)
        : undefined,
    ),
    committed: { bool: committed },
    meta: metaToWire(leg.meta),
  }));

  const executors = resolveExecutors(params.settlement);
  const originalRequestCid = params.originalRequestCid ?? params.originalRequestId;

  const argument: Record<string, unknown> = {
    settlement: {
      executors: executors.map((party) => ({ party })),
      id: { text: params.settlement.settlementRefId },
      cid: optionalWire(
        params.settlement.settlementRefCid !== undefined
          ? { contract_id: params.settlement.settlementRefCid }
          : undefined,
      ),
      meta: metaToWire(params.settlement.meta),
    },
    allocations,
    requestedAt: damlTimestamp(params.settlement.requestedAt),
    settleAt: optionalWire(damlTimestamp(settleBefore)),
    availableActions: defaultAllocationRequestActions(params.legs, executors),
    meta: metaToWire(params.meta),
    originalRequestCid: optionalWire(
      originalRequestCid !== undefined ? { contract_id: originalRequestCid } : undefined,
    ),
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
 * creates a new one referencing the original).
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

function encodeTransferLegSide(legId: string, leg: TransferLegV2): Record<string, unknown> {
  return {
    transferLegId: { text: legId },
    side: damlVariant(leg.side ?? 'SenderSide'),
    otherside: encodeAccountV2(leg.receiver),
    amount: damlNumeric(leg.amount),
    instrumentId: { text: leg.instrumentId.id },
    meta: metaToWire(leg.meta),
  };
}

function resolveExecutors(settlement: AllocationSettlementInfo): ReadonlyArray<string> {
  const executors = settlement.executors ?? [settlement.executor];
  if (executors.length === 0 || executors.some((party) => party.trim() === '')) {
    throw new Error('V2 SettlementInfo requires at least one executor party');
  }
  return [...new Set(executors)];
}

function defaultAllocationRequestActions(
  legs: BuildAllocationRequestParams['legs'],
  fallbackParties: ReadonlyArray<string>,
): Record<string, unknown> {
  const actionParties = [...new Set(
    legs.flatMap(({ leg }) => {
      const account = leg.authorizer ?? { owner: leg.sender, id: '' };
      return [account.owner, account.provider].filter((party): party is string => Boolean(party));
    }),
  )];
  const parties = actionParties.length > 0 ? actionParties : fallbackParties;
  const partyGroup = [parties.map((party) => ({ party }))];
  return genMapWire([
    { key: damlVariant('ARA_Accept'), value: partyGroup },
    { key: damlVariant('ARA_Reject'), value: partyGroup },
  ]);
}

// ---------------------------------------------------------------------------
// Allocation_Settle dispatch
// ---------------------------------------------------------------------------

/**
 * V2 iterated-allocation funding. When provided to `buildAllocationSettle`,
 * the settle exercise refills funding for the next iteration — the V2
 * primitive that backs recurring streams and prefunded trading patterns.
 */
export type NextIterationFundingAmounts = Readonly<Record<string, Decimal | string | number>>;

export interface TransferLegSideV2 {
  readonly transferLegId: string;
  readonly side: 'SenderSide' | 'ReceiverSide';
  readonly otherside: AccountV2;
  readonly amount: Decimal;
  readonly instrumentId: string;
  readonly meta?: AllocationMetadata | undefined;
}

export interface NextIterationFunding {
  /** V2-standard map keyed by instrument id text. */
  readonly amounts: NextIterationFundingAmounts;
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
  opts?: {
    readonly nextIterationFunding?: NextIterationFunding;
    readonly extraTransferLegSides?: ReadonlyArray<TransferLegSideV2>;
  },
): Promise<{ readonly version: 'v2'; readonly result: unknown }> {
  assertActionSupported(caps, 'allocation-single-leg');

  const nextWire = opts?.nextIterationFunding
    ? optionalWire(decimalTextMapWire(opts.nextIterationFunding.amounts))
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
      actors: actAs.map((party) => ({ party })),
      extraTransferLegSides: (opts?.extraTransferLegSides ?? []).map(encodeTransferLegSideForChoice),
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
    { actors: actAs.map((party) => ({ party })), extraArgs: emptyExtraArgsWire() },
    actAs,
  );
  return { version: 'v2', result };
}

// ---------------------------------------------------------------------------
// V2: SettlementFactory_SettleBatch (multi-leg / multi-allocation)
// ---------------------------------------------------------------------------

/**
 * Build a multi-leg batch settlement exercise for milestones, batched
 * stream advancement, and other CIP-0112 prefunded trading patterns.
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
  params: BatchSettlementParams,
  actAs: string[],
  logger: Logger,
): Promise<{ readonly version: 'v2'; readonly result: unknown }> {
  assertActionSupported(caps, 'allocation-batch');

  logger.info(
    { settlementFactoryCid, legCount: params.transferLegs.length },
    'Exercising SettlementFactory_SettleBatch (V2)',
  );
  const result = await transport.exercise(
    templateIdSettlementFactory,
    settlementFactoryCid,
    'SettlementFactory_SettleBatch',
    {
      settlement: {
        executors: resolveExecutors(params.settlement).map((party) => ({ party })),
        id: { text: params.settlement.settlementRefId },
        cid: optionalWire(
          params.settlement.settlementRefCid !== undefined
            ? { contract_id: params.settlement.settlementRefCid }
            : undefined,
        ),
        meta: metaToWire(params.settlement.meta),
      },
      transferLegs: params.transferLegs.map(encodeTransferLegForBatch),
      allocations: params.allocations.map((allocation) => ({
        allocationCid: { contract_id: allocation.allocationCid },
        extraTransferLegSides: (allocation.extraTransferLegSides ?? []).map(encodeTransferLegSideForChoice),
        nextIterationFunding: optionalWire(
          allocation.nextIterationFunding !== undefined
            ? decimalTextMapWire(allocation.nextIterationFunding.amounts)
            : undefined,
        ),
      })),
      actors: actAs.map((party) => ({ party })),
      extraArgs: emptyExtraArgsWire(),
    },
    actAs,
  );
  return { version: 'v2', result };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export interface BatchTransferLegV2 {
  readonly transferLegId: string;
  readonly sender: AccountV2;
  readonly receiver: AccountV2;
  readonly amount: Decimal;
  readonly instrumentId: string;
  readonly meta?: AllocationMetadata | undefined;
}

export interface FinalizedAllocationV2 {
  readonly allocationCid: string;
  readonly extraTransferLegSides?: ReadonlyArray<TransferLegSideV2> | undefined;
  readonly nextIterationFunding?: NextIterationFunding | undefined;
}

export interface BatchSettlementParams {
  readonly settlement: AllocationSettlementInfo;
  readonly transferLegs: ReadonlyArray<BatchTransferLegV2>;
  readonly allocations: ReadonlyArray<FinalizedAllocationV2>;
}

function encodeTransferLegSideForChoice(leg: TransferLegSideV2): Record<string, unknown> {
  return {
    transferLegId: { text: leg.transferLegId },
    side: damlVariant(leg.side),
    otherside: encodeAccountV2(leg.otherside),
    amount: damlNumeric(leg.amount),
    instrumentId: { text: leg.instrumentId },
    meta: metaToWire(leg.meta),
  };
}

function encodeTransferLegForBatch(leg: BatchTransferLegV2): Record<string, unknown> {
  return {
    transferLegId: { text: leg.transferLegId },
    sender: encodeAccountV2(leg.sender),
    receiver: encodeAccountV2(leg.receiver),
    amount: damlNumeric(leg.amount),
    instrumentId: { text: leg.instrumentId },
    meta: metaToWire(leg.meta),
  };
}

function emptyExtraArgsWire(): Record<string, unknown> {
  return {
    context: { values: textMapWire({}) },
    meta: metaToWire(undefined),
  };
}
