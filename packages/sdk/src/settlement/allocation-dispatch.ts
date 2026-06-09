/**
 * @module settlement/allocation-dispatch
 *
 * Single dispatcher for V2 stream settlement.
 *
 * Routes through `commands/allocation.ts` to emit `AllocationRequestV2`,
 * create `AllocationV2` via `AllocationFactory_Allocate`, settle via
 * `Allocation_Settle` (single-leg + iterated) or `SettlementFactory_SettleBatch`
 * (multi-leg).
 *
 * V1-only assets are not supported. Per CIP-0112 §5, V1 assets are
 * expected to publish V2 interfaces alongside V1; once an asset advertises
 * V2 in `supportedApis`, this dispatcher routes against it.
 *
 * The legacy settlement-reference adapters are deprecated; no asset that
 * lacks V2 allocation support is routed through this dispatcher.
 */

import Decimal from 'decimal.js';
import type { Logger } from 'pino';

import type { Transport, TemplateId } from '../transport/base.js';
import {
  type AssetCapabilities,
  assertActionSupported,
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

// Re-export Decimal so callers don't need a separate dependency line
// for setting up TransferLeg amounts.
export { Decimal };
