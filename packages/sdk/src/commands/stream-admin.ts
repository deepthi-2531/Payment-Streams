/**
 * @module commands/stream-admin
 *
 * SDK surface for the V2 `StreamAdmin` template.
 *
 * `StreamAdmin` is the admin/observability contract that records
 * per-stream metadata + pointers to the active V2 `Allocation` in the
 * iteration chain. Real custody lives in the V2 `Allocation` contract
 * created by the sender via `AllocationFactory_Allocate`; this module
 * wraps the admin-side exercises (`Sync_Iteration`, `Mark_Cancelled`,
 * `Mark_Completed`).
 *
 * ## Typical orchestration
 *
 * 1. dApp calls `buildStreamAdminCreate(...)` to produce the create
 *    command for the admin contract; operator + sender + recipient
 *    sign and submit.
 * 2. dApp calls `buildAllocationRequest(...)` (from `commands/allocation`)
 *    + the sender's V2 wallet exercises `AllocationFactory_Allocate`
 *    on the asset's V2 factory.
 * 3. Operator records the resulting allocation cid via
 *    `buildSyncIteration(..., iterationAmount=0, newAllocationCid=Some(...))`
 *    — or omits the zero-amount sync and waits for the first real
 *    `Allocation_Settle` to push the first iteration.
 * 4. On each accrual period, operator exercises V2 `Allocation_Settle`
 *    (see `commands/allocation.buildAllocationSettle`) + then
 *    `buildSyncIteration` to advance admin state.
 * 5. On cancel, operator exercises V2 `Allocation_Cancel` + then
 *    `buildMarkCancelled` to record terminal state.
 * 6. On natural completion (`nextIterationFunding=None` on the final
 *    settle), operator exercises `buildMarkCompleted`.
 *
 * V1 is not supported because stream settlement relies on V2 allocations.
 */

import Decimal from 'decimal.js';
import type { Logger } from 'pino';

import type { Transport, TemplateId } from '../transport/base.js';
import { TEMPLATE_STREAM_ADMIN } from '../templates.js';

// ---------------------------------------------------------------------------
// Daml wire helpers (mirrors `commands/allocation`)
// ---------------------------------------------------------------------------

function damlNumeric(amount: Decimal | string | number): { numeric: string } {
  return { numeric: new Decimal(amount).toFixed(10) };
}

function damlTimestamp(date: Date): { timestamp: string } {
  return { timestamp: (BigInt(date.getTime()) * 1000n).toString() };
}

function optionalText(value: string | undefined): { optional: { text: string } | null } {
  return value !== undefined ? { optional: { text: value } } : { optional: null };
}

function optionalInt(value: number | undefined): { optional: { int64: string } | null } {
  return value !== undefined ? { optional: { int64: value.toString() } } : { optional: null };
}

function damlVariant(
  variantConstructor: string,
  value: Record<string, unknown> = { unit: {} },
): Record<string, unknown> {
  return {
    variant: {
      variant_constructor: variantConstructor,
      value,
    },
  };
}

function damlEnum(enumConstructor: string): Record<string, unknown> {
  return { enum: { enum_constructor: enumConstructor } };
}

// ---------------------------------------------------------------------------
// Vesting mode encoding — mirrors `CantonStreams.Interface.Types.VestingMode`
// ---------------------------------------------------------------------------

export type VestingMode =
  | { readonly tag: 'Linear' }
  | { readonly tag: 'CliffLinear'; readonly cliffTime: Date }
  | { readonly tag: 'Stepped'; readonly stepIntervalMicros: bigint; readonly amountPerStep: Decimal }
  | { readonly tag: 'RenewableTerm'; readonly termDurationMicros: bigint };

function encodeVestingMode(vm: VestingMode): Record<string, unknown> {
  switch (vm.tag) {
    case 'Linear':
      return damlVariant('Linear');
    case 'CliffLinear':
      return damlVariant('CliffLinear', { cliffTime: damlTimestamp(vm.cliffTime) });
    case 'Stepped':
      // RelTime is `{ microseconds : Int }`; the inner field must be
      // wrapped with the `{ int64: ... }` tag so the transport's
      // `encodeValue` emits a `Value.int64` rather than falling through
      // to the default `string → text` branch (the bug the ledger
      // surfaces as "mismatching type: Int64 and value: ValueText").
      return damlVariant('Stepped', {
        stepInterval: { microseconds: { int64: vm.stepIntervalMicros.toString() } },
        amountPerStep: damlNumeric(vm.amountPerStep),
      });
    case 'RenewableTerm':
      return damlVariant('RenewableTerm', {
        termDuration: { microseconds: { int64: vm.termDurationMicros.toString() } },
      });
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Asset reference shape, mirrors `CantonStreams.Interface.Types.InstrumentRef`. */
export interface InstrumentRefSdk {
  readonly depository: string;
  readonly issuer: string;
  readonly instrumentId: string;
  readonly instrumentVersion: string;
}

/** Parameters for `buildStreamAdminCreate`. */
export interface CreateStreamAdminParams {
  readonly streamId: string;
  readonly sender: string;
  readonly recipient: string;
  readonly operator: string;
  readonly instrumentRef: InstrumentRefSdk;
  readonly totalDeposited: Decimal;
  readonly vestingMode: VestingMode;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly cancellable: boolean;
  readonly observers?: ReadonlyArray<string>;
}

/** Result of `buildStreamAdminCreate` — the create call payload. */
export interface StreamAdminCreatePayload {
  readonly templateId: TemplateId;
  readonly argument: Record<string, unknown>;
  readonly signatories: ReadonlyArray<string>;
}

/**
 * Build the create payload for a new `StreamAdmin` contract. Caller
 * dispatches this via the transport with the sender as `actAs`. Recipient
 * consent and operator settlement authority live in the V2 token-standard
 * allocation contracts.
 */
export function buildStreamAdminCreate(
  params: CreateStreamAdminParams,
): StreamAdminCreatePayload {
  return {
    templateId: TEMPLATE_STREAM_ADMIN,
    argument: {
      streamId: { text: params.streamId },
      sender: { party: params.sender },
      recipient: { party: params.recipient },
      operator: { party: params.operator },
      instrumentRef: {
        depository: { party: params.instrumentRef.depository },
        issuer: { party: params.instrumentRef.issuer },
        instrumentId: { text: params.instrumentRef.instrumentId },
        instrumentVersion: { text: params.instrumentRef.instrumentVersion },
      },
      totalDeposited: damlNumeric(params.totalDeposited),
      vestingMode: encodeVestingMode(params.vestingMode),
      startTime: damlTimestamp(params.startTime),
      endTime: damlTimestamp(params.endTime),
      cancellable: { bool: params.cancellable },
      totalWithdrawn: damlNumeric(0),
      numIterations: { int64: '0' },
      status: damlEnum('Active'),
      currentAllocationCid: { optional: null },
      originalAllocationId: { optional: null },
      observers: (params.observers ?? []).map((p) => ({ party: p })),
    },
    signatories: [params.sender],
  };
}

// ---------------------------------------------------------------------------
// Sync_Iteration
// ---------------------------------------------------------------------------

/** Parameters for `buildSyncIteration` — recording an iteration advance. */
export interface SyncIterationParams {
  readonly adminCid: string;
  readonly operator: string;
  readonly iterationAmount: Decimal;
  readonly newAllocationCid?: string | undefined;
  readonly expectedIteration?: number;
}

/**
 * Record an iteration advance on a `StreamAdmin` contract.
 *
 * Call this after the operator exercises V2 `Allocation_Settle`. The
 * iteration amount must match what the underlying settle transferred;
 * `newAllocationCid` is the next iteration's allocation (omit for the
 * final iteration when `nextIterationFunding = None`).
 */
export async function buildSyncIteration(
  transport: Transport,
  params: SyncIterationParams,
  logger: Logger,
): Promise<{ readonly newAdminCid: string; readonly version: 'v2' }> {
  logger.info(
    {
      adminCid: params.adminCid,
      iterationAmount: params.iterationAmount.toString(),
      newAllocationCid: params.newAllocationCid,
    },
    'Exercising Sync_Iteration on StreamAdmin (V2)',
  );
  const result = (await transport.exercise(
    TEMPLATE_STREAM_ADMIN,
    params.adminCid,
    'Sync_Iteration',
    {
      iterationAmount: damlNumeric(params.iterationAmount),
      newAllocationCid: optionalText(params.newAllocationCid),
      expectedIteration: optionalInt(params.expectedIteration),
    },
    [params.operator],
  )) as { contractId?: string };
  return {
    newAdminCid: result.contractId ?? '',
    version: 'v2',
  };
}

// ---------------------------------------------------------------------------
// Mark_Cancelled
// ---------------------------------------------------------------------------

/** Parameters for `buildMarkCancelled`. */
export interface MarkCancelledParams {
  readonly adminCid: string;
  readonly operator: string;
  readonly cancelTime: Date;
  readonly finalWithdrawn: Decimal;
}

/**
 * Mark a `StreamAdmin` as cancelled after the underlying V2
 * `Allocation_Cancel` settles. `finalWithdrawn` is the cumulative
 * amount the recipient received before cancellation (must be ≥ current
 * `totalWithdrawn` on the admin contract).
 */
export async function buildMarkCancelled(
  transport: Transport,
  params: MarkCancelledParams,
  logger: Logger,
): Promise<{ readonly newAdminCid: string; readonly version: 'v2' }> {
  logger.info(
    {
      adminCid: params.adminCid,
      finalWithdrawn: params.finalWithdrawn.toString(),
    },
    'Exercising Mark_Cancelled on StreamAdmin (V2)',
  );
  const result = (await transport.exercise(
    TEMPLATE_STREAM_ADMIN,
    params.adminCid,
    'Mark_Cancelled',
    {
      cancelTime: damlTimestamp(params.cancelTime),
      finalWithdrawn: damlNumeric(params.finalWithdrawn),
    },
    [params.operator],
  )) as { contractId?: string };
  return {
    newAdminCid: result.contractId ?? '',
    version: 'v2',
  };
}

// ---------------------------------------------------------------------------
// Mark_Completed
// ---------------------------------------------------------------------------

/** Parameters for `buildMarkCompleted`. */
export interface MarkCompletedParams {
  readonly adminCid: string;
  readonly operator: string;
}

/**
 * Mark a `StreamAdmin` as completed. Used when the iteration chain
 * naturally terminates (`nextIterationFunding = None` on the final
 * settle). Idempotent if already `Completed`.
 */
export async function buildMarkCompleted(
  transport: Transport,
  params: MarkCompletedParams,
  logger: Logger,
): Promise<{ readonly newAdminCid: string; readonly version: 'v2' }> {
  logger.info(
    { adminCid: params.adminCid },
    'Exercising Mark_Completed on StreamAdmin (V2)',
  );
  const result = (await transport.exercise(
    TEMPLATE_STREAM_ADMIN,
    params.adminCid,
    'Mark_Completed',
    {},
    [params.operator],
  )) as { contractId?: string };
  return {
    newAdminCid: result.contractId ?? '',
    version: 'v2',
  };
}
