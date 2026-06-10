/**
 * @module settlement/allocation-dispatch
 *
 * Dispatchers for stream settlement — V2 (preferred) and V1 (transitional).
 *
 * **V2 lane** (`dispatchSettlement`): routes through `commands/allocation.ts`
 * to emit `AllocationRequestV2`, create `AllocationV2` via
 * `AllocationFactory_Allocate`, settle via `Allocation_Settle` (single-leg +
 * iterated) or `SettlementFactory_SettleBatch` (multi-leg).
 *
 * **V1 lane** (`dispatchSettlementV1`): routes through
 * `commands/allocation-v1.ts` (`splice-api-token-allocation-v1`) for assets
 * live on MainNet that have not yet published V2 interfaces (Canton Coin /
 * Amulet, USDCx). No iteration, no batch factory — recurring streams run one
 * allocation cycle per withdrawal. Deprecated from birth; delete
 * `dispatchSettlementV1`, its command types, and `commands/allocation-v1.ts`
 * once the reference assets advertise V2 (`allocationsV2 = true`).
 *
 * Lane selection: callers resolve the lane once via
 * `resolveSettlementVersion(caps)` and pick the matching dispatcher. The
 * command payloads are wire-incompatible between lanes (V2 Accounts vs V1
 * plain parties), so the lanes deliberately do not share command types.
 *
 * The legacy settlement-reference adapters remain deprecated; assets enter
 * a dispatcher only via registry capability flags.
 */

import Decimal from 'decimal.js';
import type { Logger } from 'pino';

import type { Transport, TemplateId } from '../transport/base.js';
import {
  type AssetCapabilities,
  type SettlementApiVersion,
  assertActionSupported,
  resolveSettlementVersion,
} from '../assets/capabilities.js';
import {
  buildAllocationRequest,
  buildAllocationSettle,
  buildAllocationCancel,
  buildBatchSettlement,
  type AllocationRequestPayload,
  type BuildAllocationRequestParams,
  type NextIterationFunding,
  type TransferLegV2,
  type AllocationSettlementInfo,
  type BatchSettlementParams,
} from '../commands/allocation.js';
import {
  buildAllocationRequestV1,
  buildAllocationExecuteTransferV1,
  buildAllocationCancelV1,
  buildAllocationWithdrawV1,
  type BuildAllocationRequestV1Params,
  type ChoiceContextV1,
  type SettlementInfoV1,
  type TransferLegV1,
} from '../commands/allocation-v1.js';

// ---------------------------------------------------------------------------
// Public dispatch surface
// ---------------------------------------------------------------------------

/**
 * Action categories the dispatcher understands. Each maps onto a
 * specific V2 AllocationRequest / Allocation_Settle pattern.
 */
export type DispatchAction =
  | 'emit-request'
  | 'settle'
  | 'cancel'
  | 'batch-settle';

/**
 * Parameters for `dispatchSettlement`. Discriminated by `action`:
 *
 *   - `emit-request` builds + creates an AllocationRequestV2 contract
 *   - `settle`       exercises `Allocation_Settle` on an existing AllocationV2
 *                    (optionally with `nextIterationFunding` for iterated)
 *   - `cancel`       exercises `Allocation_Cancel`
 *   - `batch-settle` exercises `SettlementFactory_SettleBatch`
 */
export type DispatchCommand =
  | EmitRequestCommand
  | SettleCommand
  | CancelCommand
  | BatchSettleCommand;

export interface EmitRequestCommand {
  readonly action: 'emit-request';
  readonly request: BuildAllocationRequestParams;
  readonly templateId: TemplateId;
  readonly actAs: ReadonlyArray<string>;
}

export interface SettleCommand {
  readonly action: 'settle';
  readonly allocationCid: string;
  readonly templateId: TemplateId;
  readonly actAs: ReadonlyArray<string>;
  readonly nextIterationFunding?: NextIterationFunding | undefined;
}

export interface CancelCommand {
  readonly action: 'cancel';
  readonly allocationCid: string;
  readonly templateId: TemplateId;
  readonly actAs: ReadonlyArray<string>;
}

export interface BatchSettleCommand {
  readonly action: 'batch-settle';
  readonly settlementFactoryCid: string;
  readonly templateIdSettlementFactory: TemplateId;
  readonly batch: BatchSettlementParams;
  readonly actAs: ReadonlyArray<string>;
}

/**
 * Result envelope. `version` is always `'v2'`.
 * Kept as a field so the proxy + tests can assert it explicitly.
 */
export interface DispatchResult {
  readonly version: 'v2';
  readonly action: DispatchAction;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Single entry point for all V2 stream settlement actions.
 *
 * @param transport      Ledger transport for issuing commands.
 * @param caps           Asset capabilities (asserted to support V2).
 * @param cmd            Discriminated dispatch command.
 * @param logger         Structured logger.
 */
export async function dispatchSettlement(
  transport: Transport,
  caps: AssetCapabilities,
  cmd: DispatchCommand,
  logger: Logger,
): Promise<DispatchResult> {
  // Assert the asset supports the action; this also fails fast for
  // paused instruments.
  const action: 'transfer' | 'allocation-batch' =
    cmd.action === 'batch-settle' ? 'allocation-batch' : 'transfer';
  assertActionSupported(caps, action);

  switch (cmd.action) {
    case 'emit-request': {
      const payload = buildAllocationRequest(caps, cmd.request, cmd.templateId);
      logger.info({ version: 'v2', action: 'emit-request' }, 'Creating AllocationRequestV2');
      const created = await transport.create(payload.templateId, payload.argument, [...cmd.actAs]);
      return { version: 'v2', action: 'emit-request', payload: created };
    }

    case 'settle': {
      const settled = await buildAllocationSettle(
        transport,
        caps,
        cmd.allocationCid,
        cmd.templateId,
        [...cmd.actAs],
        logger,
        cmd.nextIterationFunding ? { nextIterationFunding: cmd.nextIterationFunding } : undefined,
      );
      return { version: 'v2', action: 'settle', payload: settled.result };
    }

    case 'cancel': {
      const cancelled = await buildAllocationCancel(
        transport,
        caps,
        cmd.allocationCid,
        cmd.templateId,
        [...cmd.actAs],
        logger,
      );
      return { version: 'v2', action: 'cancel', payload: cancelled.result };
    }

    case 'batch-settle': {
      const batched = await buildBatchSettlement(
        transport,
        caps,
        cmd.settlementFactoryCid,
        cmd.templateIdSettlementFactory,
        cmd.batch,
        [...cmd.actAs],
        logger,
      );
      return { version: 'v2', action: 'batch-settle', payload: batched.result };
    }
  }
}

// ---------------------------------------------------------------------------
// V1 lane (transitional — see module doc for the removal plan)
// ---------------------------------------------------------------------------

/**
 * V1 action categories. `withdraw` is V1-only (sender-side
 * `Allocation_Withdraw`); there is no batch action because V1 has no
 * settlement factory.
 */
export type DispatchActionV1 = 'emit-request' | 'settle' | 'cancel' | 'withdraw';

/**
 * V1 dispatch commands. Deliberately a separate union from
 * {@link DispatchCommand}: the request payloads are wire-incompatible
 * (V1 plain-party legs vs V2 Account legs), and keeping the types apart
 * lets the whole V1 lane be deleted without touching V2 call-sites.
 */
export type DispatchCommandV1 =
  | EmitRequestV1Command
  | SettleV1Command
  | CancelV1Command
  | WithdrawV1Command;

export interface EmitRequestV1Command {
  readonly action: 'emit-request';
  readonly request: BuildAllocationRequestV1Params;
  readonly templateId: TemplateId;
  readonly actAs: ReadonlyArray<string>;
}

export interface SettleV1Command {
  readonly action: 'settle';
  readonly allocationCid: string;
  readonly templateId: TemplateId;
  readonly actAs: ReadonlyArray<string>;
  /**
   * Registry choice context (e.g. Amulet's AmuletRules / OpenMiningRound
   * references fetched from the registry's choice-context endpoint).
   */
  readonly context?: ChoiceContextV1 | undefined;
}

export interface CancelV1Command {
  readonly action: 'cancel';
  readonly allocationCid: string;
  readonly templateId: TemplateId;
  readonly actAs: ReadonlyArray<string>;
  readonly context?: ChoiceContextV1 | undefined;
}

export interface WithdrawV1Command {
  readonly action: 'withdraw';
  readonly allocationCid: string;
  readonly templateId: TemplateId;
  readonly actAs: ReadonlyArray<string>;
  readonly context?: ChoiceContextV1 | undefined;
}

/** Result envelope for the V1 lane. `version` is always `'v1'`. */
export interface DispatchResultV1 {
  readonly version: 'v1';
  readonly action: DispatchActionV1;
  readonly payload: unknown;
}

/**
 * Single entry point for V1 stream settlement actions. Parallel to
 * {@link dispatchSettlement}; see the module doc for lane selection.
 *
 * @deprecated from birth — transitional until CC / USDCx advertise V2.
 */
export async function dispatchSettlementV1(
  transport: Transport,
  caps: AssetCapabilities,
  cmd: DispatchCommandV1,
  logger: Logger,
): Promise<DispatchResultV1> {
  // Fail fast for paused instruments and V2-only capability mistakes.
  assertActionSupported(caps, 'transfer', 'v1');

  switch (cmd.action) {
    case 'emit-request': {
      const payload = buildAllocationRequestV1(caps, cmd.request, cmd.templateId);
      logger.info({ version: 'v1', action: 'emit-request' }, 'Creating AllocationRequest (V1)');
      const created = await transport.create(payload.templateId, payload.argument, [...cmd.actAs]);
      return { version: 'v1', action: 'emit-request', payload: created };
    }

    case 'settle': {
      const settled = await buildAllocationExecuteTransferV1(
        transport,
        caps,
        cmd.allocationCid,
        cmd.templateId,
        [...cmd.actAs],
        logger,
        cmd.context !== undefined ? { context: cmd.context } : undefined,
      );
      return { version: 'v1', action: 'settle', payload: settled.result };
    }

    case 'cancel': {
      const cancelled = await buildAllocationCancelV1(
        transport,
        caps,
        cmd.allocationCid,
        cmd.templateId,
        [...cmd.actAs],
        logger,
        cmd.context !== undefined ? { context: cmd.context } : undefined,
      );
      return { version: 'v1', action: 'cancel', payload: cancelled.result };
    }

    case 'withdraw': {
      const withdrawn = await buildAllocationWithdrawV1(
        transport,
        caps,
        cmd.allocationCid,
        cmd.templateId,
        [...cmd.actAs],
        logger,
        cmd.context !== undefined ? { context: cmd.context } : undefined,
      );
      return { version: 'v1', action: 'withdraw', payload: withdrawn.result };
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience builders (for proxy/orchestrator integration)
// ---------------------------------------------------------------------------

/**
 * Build a `settle` command for a stream withdrawal cycle. Used by the
 * proxy's transfer-events subscriber when it reacts to an
 * `Allocation_Settle` event by exercising the stream-advancing choice.
 */
export function buildWithdrawalSettleCommand(args: {
  readonly allocationCid: string;
  readonly templateId: TemplateId;
  readonly actAs: ReadonlyArray<string>;
  readonly nextIterationFunding?: NextIterationFunding | undefined;
}): SettleCommand {
  const result: SettleCommand = {
    action: 'settle',
    allocationCid: args.allocationCid,
    templateId: args.templateId,
    actAs: args.actAs,
  };
  if (args.nextIterationFunding !== undefined) {
    return { ...result, nextIterationFunding: args.nextIterationFunding };
  }
  return result;
}

/**
 * Build an `emit-request` command from a stream withdrawal context.
 * Constructs the settlement info from per-cycle inputs and wraps the
 * caller's leg(s).
 */
export function buildWithdrawalRequestCommand(args: {
  readonly settlement: AllocationSettlementInfo;
  readonly legs: ReadonlyArray<{
    readonly legId: string;
    readonly leg: TransferLegV2;
  }>;
  readonly meta?: Readonly<Record<string, string>>;
  readonly templateId: TemplateId;
  readonly actAs: ReadonlyArray<string>;
}): EmitRequestCommand {
  const requestParams: BuildAllocationRequestParams =
    args.meta !== undefined
      ? { settlement: args.settlement, legs: args.legs, meta: args.meta }
      : { settlement: args.settlement, legs: args.legs };
  return {
    action: 'emit-request',
    request: requestParams,
    templateId: args.templateId,
    actAs: args.actAs,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type {
  AllocationRequestPayload,
  BuildAllocationRequestParams,
  NextIterationFunding,
  AllocationSettlementInfo,
  TransferLegV2,
  BatchSettlementParams,
};

// V1 lane re-exports (transitional — removed with the lane).
export type {
  BuildAllocationRequestV1Params,
  ChoiceContextV1,
  SettlementInfoV1,
  TransferLegV1,
  SettlementApiVersion,
};
export { resolveSettlementVersion };

// Re-export Decimal so callers don't need a separate dependency line
// for setting up TransferLeg amounts.
export { Decimal };
