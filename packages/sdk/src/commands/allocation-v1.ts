/**
 * @module commands/allocation-v1
 *
 * CIP-56 V1 settlement lane — `splice-api-token-allocation-v1` vocabulary.
 *
 * This is the **transitional** lane for assets that are live on MainNet
 * today (Canton Coin / Amulet, USDCx) but have not yet published the
 * CIP-0112 V2 interfaces. It mirrors `commands/allocation.ts` (the V2
 * lane) shape-for-shape so the two can be maintained side by side and
 * the V1 lane can be deleted in a single commit once the reference
 * assets advertise V2.
 *
 * Deliberate design choices:
 *
 *   - **Self-contained.** Wire helpers are duplicated from the V2 module
 *     rather than shared, so deleting this file (plus the `'v1'` branch
 *     in `settlement/allocation-dispatch.ts`) removes the lane with zero
 *     residue in the V2 path.
 *   - **No iteration, no batch.** V1 has no committed-iterated allocation
 *     and no `SettlementFactory_SettleBatch`. Recurring streams on the V1
 *     lane run one request → allocate → execute cycle per withdrawal,
 *     driven by the executor/proxy. Callers that pass iteration or batch
 *     parameters get a descriptive error, not silent degradation.
 *   - **Choice context is caller-supplied.** Registry implementations
 *     (notably Amulet) require an off-ledger choice context (e.g.
 *     AmuletRules / OpenMiningRound references fetched from the registry's
 *     `/registry/allocations/v1/{cid}/choice-contexts/...` endpoint).
 *     The builders accept an optional {@link ChoiceContextV1} and encode
 *     it into `extraArgs.context`; fetching it is the caller's concern.
 *
 * V1 vocabulary used here (per `splice-api-token-allocation-v1`):
 *
 *   - `AllocationRequest` view: `{ settlement, transferLegs, meta }`
 *   - `SettlementInfo`: single `executor` party + `settlementRef`
 *   - `TransferLeg`: plain `sender` / `receiver` parties (no V2 Account)
 *   - `Allocation_ExecuteTransfer` / `Allocation_Cancel` / `Allocation_Withdraw`
 *
 * @deprecated from birth — scheduled for removal once CC and USDCx
 * advertise CIP-56 V2 (`allocationsV2 = true` in the asset registry).
 * Track removal in the changelog under "V1 lane retirement".
 */

import Decimal from 'decimal.js';
import type { Logger } from 'pino';

import type { Transport, TemplateId, DisclosedContract } from '../transport/base.js';
import {
  type AssetCapabilities,
  assertActionSupported,
} from '../assets/capabilities.js';

// ---------------------------------------------------------------------------
// V1 wire types (wire-compatible with the published Splice.Api.Token.* V1
// interfaces)
// ---------------------------------------------------------------------------

/**
 * V1 instrument id — `{ admin, id }`, per `Splice.Api.Token.HoldingV1.InstrumentId`.
 * Structurally identical to the V2 shape; aliased so V1 call-sites read
 * unambiguously.
 */
export interface InstrumentIdV1 {
  readonly admin: string;
  readonly id: string;
}

/** Common settlement metadata (same Text→Text map as the V2 lane). */
export type AllocationMetadataV1 = Record<string, string>;

/**
 * Attribution metadata keys stamped on every allocation the SDK builds.
 *
 * Asset-side events (e.g. AmuletAllocation) are visible on public Scan
 * because the instrument admin (DSO) is a stakeholder — while the stream
 * contracts themselves stay private to the stream's parties. These keys
 * make Streams usage independently discoverable and countable on Scan
 * (Milestone-5 attribution) without exposing any stream terms.
 */
export const META_KEY_STREAMS_REF = 'cantonstreams.dev/ref';
export const META_KEY_STREAMS_VERSION = 'cantonstreams.dev/v';
/**
 * Integrator app identity. Set once per deployment (param or the
 * `CANTON_STREAMS_APP_ID` env var) so per-app usage rollups can be
 * computed from public Scan. Without it, reporting falls back to the
 * sender party's namespace prefix.
 */
export const META_KEY_STREAMS_APP = 'cantonstreams.dev/app';
/** Stamp value for {@link META_KEY_STREAMS_VERSION}. */
export const META_STREAMS_VERSION = '1';

/** Merge the standard attribution keys into caller metadata (caller wins). */
function stampAttribution(
  meta: AllocationMetadataV1 | undefined,
  settlementRefId: string,
  appId?: string,
): AllocationMetadataV1 {
  const resolvedAppId = appId ?? process.env['CANTON_STREAMS_APP_ID'];
  return {
    [META_KEY_STREAMS_REF]: settlementRefId,
    [META_KEY_STREAMS_VERSION]: META_STREAMS_VERSION,
    ...(resolvedAppId ? { [META_KEY_STREAMS_APP]: resolvedAppId } : {}),
    ...(meta ?? {}),
  };
}

/**
 * V1 `SettlementInfo` — exactly one executor party, plus a settlement
 * reference (`Reference { id, cid }`).
 */
export interface SettlementInfoV1 {
  readonly executor: string;
  readonly settlementRefId: string;
  /** Optional contract-id settlement reference (`Reference.cid`). */
  readonly settlementRefCid?: string | undefined;
  readonly requestedAt: Date;
  readonly allocateBefore?: Date | undefined;
  readonly settleBefore?: Date | undefined;
  readonly meta?: AllocationMetadataV1 | undefined;
}

/**
 * V1 `TransferLeg` — sender and receiver are plain parties. There is no
 * Account / provider structure in V1.
 */
export interface TransferLegV1 {
  readonly sender: string;
  readonly receiver: string;
  readonly amount: Decimal;
  readonly instrumentId: InstrumentIdV1;
  readonly meta?: AllocationMetadataV1 | undefined;
}

/**
 * Registry choice context for V1 choice exercises. Amulet (and other
 * registries with off-ledger state) require context values fetched from
 * the registry API before `Allocation_ExecuteTransfer` can be exercised.
 *
 * `values` is encoded into `extraArgs.context.values`. Disclosed
 * contracts returned by the registry endpoint must currently be handled
 * at the transport/session level; see the module doc.
 */
export interface ChoiceContextV1 {
  readonly values: Readonly<Record<string, unknown>>;
  /**
   * Contracts the registry requires the submitter to disclose alongside
   * the choice (AmuletRules, OpenMiningRound, …), as returned by the
   * registry's choice-context endpoint. Passed through to the transport.
   */
  readonly disclosedContracts?: ReadonlyArray<DisclosedContract>;
}

/**
 * Parameters for {@link buildAllocationRequestV1}. Mirrors the V2
 * builder's `{ settlement, legs }` shape; legs become the V1
 * `transferLegs : TextMap TransferLeg`.
 *
 * The default target template is `StreamAllocationRequestV1` from the
 * `canton-streams-v1-shim` DAR, whose create argument is
 * `{ requestedBy, settlement, transferLegs, meta }`.
 */
export interface BuildAllocationRequestV1Params {
  /**
   * Party creating the request (the stream operator or sender
   * automation). Sole signatory of the shim template.
   */
  readonly requestedBy: string;
  readonly settlement: SettlementInfoV1;
  readonly legs: ReadonlyArray<{
    readonly legId: string;
    readonly leg: TransferLegV1;
  }>;
  readonly meta?: AllocationMetadataV1 | undefined;
  /**
   * Integrator app id stamped as `cantonstreams.dev/app` for per-app
   * usage attribution. Falls back to env `CANTON_STREAMS_APP_ID`.
   */
  readonly appId?: string | undefined;
}

/**
 * Output of {@link buildAllocationRequestV1} — a create payload ready to
 * be submitted via the transport. `version` is always `'v1'` so tests
 * and the dispatcher can assert the lane explicitly.
 */
export interface AllocationRequestV1Payload {
  readonly version: 'v1';
  readonly templateId: TemplateId;
  readonly argument: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Wire helpers — intentionally duplicated from the V2 module (see module doc)
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

function metaToWire(meta: AllocationMetadataV1 | undefined): Record<string, unknown> {
  const textValues = Object.fromEntries(
    Object.entries(meta ?? {}).map(([key, value]) => [key, { text: value }]),
  );
  return { values: textMapWire(textValues) };
}

function extraArgsWire(context: ChoiceContextV1 | undefined): Record<string, unknown> {
  return {
    context: { values: textMapWire(context?.values) },
    meta: metaToWire(undefined),
  };
}

/** Build transport CommandOptions from a choice context's disclosures. */
function commandOptions(
  context: ChoiceContextV1 | undefined,
): { disclosedContracts: ReadonlyArray<DisclosedContract> } | undefined {
  if (!context?.disclosedContracts || context.disclosedContracts.length === 0) {
    return undefined;
  }
  return { disclosedContracts: context.disclosedContracts };
}

// ---------------------------------------------------------------------------
// Build a V1 AllocationRequest create payload
// ---------------------------------------------------------------------------

/**
 * Construct a V1 `AllocationRequest` create payload: `{ settlement,
 * transferLegs, meta }` per the V1 interface view.
 *
 * @param caps        Asset capabilities (asserted to support the action on V1).
 * @param params      Settlement + legs + metadata.
 * @param templateId  TemplateId of the V1 AllocationRequest implementer on the ledger.
 */
export function buildAllocationRequestV1(
  caps: AssetCapabilities,
  params: BuildAllocationRequestV1Params,
  templateId: TemplateId,
): AllocationRequestV1Payload {
  const isMultiLeg = params.legs.length > 1;
  assertActionSupported(
    caps,
    isMultiLeg ? 'allocation-multi-leg' : 'allocation-single-leg',
    'v1',
  );
  if (params.settlement.executor.trim() === '') {
    throw new Error('V1 SettlementInfo requires a non-empty executor party');
  }

  // Default deadlines mirror the V2 lane: allocateBefore defaults to
  // requestedAt; settleBefore defaults to allocateBefore + 5 minutes.
  const allocateBefore = params.settlement.allocateBefore ?? params.settlement.requestedAt;
  const settleBefore =
    params.settlement.settleBefore ?? new Date(allocateBefore.getTime() + 5 * 60 * 1000);

  const transferLegs = textMapWire(
    Object.fromEntries(
      params.legs.map(({ legId, leg }) => [legId, encodeTransferLegV1(leg)]),
    ),
  );

  if (params.requestedBy.trim() === '') {
    throw new Error('V1 allocation request requires a non-empty requestedBy party');
  }

  const argument: Record<string, unknown> = {
    requestedBy: { party: params.requestedBy },
    settlement: {
      executor: { party: params.settlement.executor },
      settlementRef: {
        id: { text: params.settlement.settlementRefId },
        cid: optionalWire(
          params.settlement.settlementRefCid !== undefined
            ? { contract_id: params.settlement.settlementRefCid }
            : undefined,
        ),
      },
      requestedAt: damlTimestamp(params.settlement.requestedAt),
      allocateBefore: damlTimestamp(allocateBefore),
      settleBefore: damlTimestamp(settleBefore),
      // Attribution keys ride the settlement meta so the asset-side
      // allocation is discoverable on public Scan (see META_KEY_*).
      meta: metaToWire(stampAttribution(params.settlement.meta, params.settlement.settlementRefId, params.appId)),
    },
    transferLegs,
    meta: metaToWire(params.meta),
  };

  return { version: 'v1', templateId, argument };
}

function encodeTransferLegV1(leg: TransferLegV1): Record<string, unknown> {
  return {
    sender: { party: leg.sender },
    receiver: { party: leg.receiver },
    amount: damlNumeric(leg.amount),
    instrumentId: {
      admin: { party: leg.instrumentId.admin },
      id: { text: leg.instrumentId.id },
    },
    meta: metaToWire(leg.meta),
  };
}

// ---------------------------------------------------------------------------
// V1 Allocation choice exercises
// ---------------------------------------------------------------------------

/**
 * Exercise `Allocation_ExecuteTransfer` on a V1 Allocation. This is the
 * V1 settlement step — the executor (escrow operator) transfers the
 * allocated amount to the receiver. The V1 analogue of `Allocation_Settle`,
 * minus iteration.
 */
export async function buildAllocationExecuteTransferV1(
  transport: Transport,
  caps: AssetCapabilities,
  allocationCid: string,
  templateId: TemplateId,
  actAs: string[],
  logger: Logger,
  opts?: { readonly context?: ChoiceContextV1 },
): Promise<{ readonly version: 'v1'; readonly result: unknown }> {
  assertActionSupported(caps, 'allocation-single-leg', 'v1');
  logger.info(
    { allocationCid, version: 'v1' },
    'Exercising Allocation_ExecuteTransfer (V1)',
  );
  const result = await transport.exercise(
    templateId,
    allocationCid,
    'Allocation_ExecuteTransfer',
    { extraArgs: extraArgsWire(opts?.context) },
    actAs,
    undefined,
    commandOptions(opts?.context),
  );
  return { version: 'v1', result };
}

/**
 * Exercise `Allocation_Cancel` on an outstanding V1 Allocation
 * (executor-side abort; releases the locked holding back to the sender).
 */
export async function buildAllocationCancelV1(
  transport: Transport,
  caps: AssetCapabilities,
  allocationCid: string,
  templateId: TemplateId,
  actAs: string[],
  logger: Logger,
  opts?: { readonly context?: ChoiceContextV1 },
): Promise<{ readonly version: 'v1'; readonly result: unknown }> {
  assertActionSupported(caps, 'allocation-single-leg', 'v1');
  logger.info({ allocationCid, version: 'v1' }, 'Exercising Allocation_Cancel (V1)');
  const result = await transport.exercise(
    templateId,
    allocationCid,
    'Allocation_Cancel',
    { extraArgs: extraArgsWire(opts?.context) },
    actAs,
    undefined,
    commandOptions(opts?.context),
  );
  return { version: 'v1', result };
}

/**
 * Exercise `Allocation_Withdraw` on an outstanding V1 Allocation
 * (sender-side withdrawal before the settlement executes).
 */
export async function buildAllocationWithdrawV1(
  transport: Transport,
  caps: AssetCapabilities,
  allocationCid: string,
  templateId: TemplateId,
  actAs: string[],
  logger: Logger,
  opts?: { readonly context?: ChoiceContextV1 },
): Promise<{ readonly version: 'v1'; readonly result: unknown }> {
  assertActionSupported(caps, 'allocation-single-leg', 'v1');
  logger.info({ allocationCid, version: 'v1' }, 'Exercising Allocation_Withdraw (V1)');
  const result = await transport.exercise(
    templateId,
    allocationCid,
    'Allocation_Withdraw',
    { extraArgs: extraArgsWire(opts?.context) },
    actAs,
    undefined,
    commandOptions(opts?.context),
  );
  return { version: 'v1', result };
}
