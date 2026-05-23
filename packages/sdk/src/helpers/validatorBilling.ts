/**
 * @module helpers/validatorBilling
 *
 * High-level helper for the canonical Gateway.fm-shape use case:
 * validator and infrastructure service billing through recurring or
 * metered streaming payments.
 *
 * Two billing models supported:
 *
 *   1. **Term-based recurring** (`buildRecurringBillingStream`) —
 *      `RenewableTerm` vesting over a monthly billing period. Customer
 *      pre-pays for the period; service-provider Gateway.fm withdraws
 *      on the standard cadence. Sender can renew for the next period.
 *
 *   2. **Usage-based rolling** (`buildUsageBillingFlow`) — produces
 *      a StreamFlow config rather than a CreateStreamParams (since the
 *      non-prefunded streaming model lives in StreamFlow). Flow rate
 *      = per-unit price; the provider withdraws as units are consumed.
 *
 * Both models use TokenStandardCustody with CC as the typical billing
 * asset.
 */

import Decimal from 'decimal.js';

import { SettlementMode, AssetType } from '../types/stream.js';
import type {
  CreateStreamParams,
  InstrumentRef,
  VestingModeConfig,
} from '../types/stream.js';

export interface RecurringBillingOptions {
  readonly streamId: string;
  /** Customer party (pays Gateway.fm). */
  readonly payer: string;
  /** Service provider party (e.g. Gateway.fm). */
  readonly payee: string;
  /** Amount per billing period (in asset smallest unit). */
  readonly amountPerPeriod: Decimal | string | number;
  /** Billing period length in days. Defaults to 30 (monthly). */
  readonly periodDays?: number;
  /** When the first billing period begins. */
  readonly startTime: Date;
  /** Number of pre-paid periods funded up-front. Defaults to 1. */
  readonly totalPeriods?: number;
  /** Billing asset (CC typically). */
  readonly instrumentRef: InstrumentRef;
  /** Escrow operator party. */
  readonly escrowOperator: string;
  /** Customer can cancel (e.g. service degradation). Defaults to true. */
  readonly cancellable?: boolean;
}

/**
 * Construct CreateStreamParams for a recurring billing stream.
 *
 * Uses `RenewableTerm` so the customer can extend for additional
 * periods without creating new streams. The service provider withdraws
 * on the term schedule.
 */
export function buildRecurringBillingStream(
  opts: RecurringBillingOptions,
): CreateStreamParams {
  const periodDays = opts.periodDays ?? 30;
  const totalPeriods = opts.totalPeriods ?? 1;
  if (totalPeriods < 1) {
    throw new Error('totalPeriods must be at least 1');
  }
  const total = new Decimal(opts.amountPerPeriod).mul(totalPeriods);
  const endTime = new Date(opts.startTime.getTime() + totalPeriods * periodDays * 24 * 60 * 60 * 1000);

  const vestingMode: VestingModeConfig = {
    kind: 'RenewableTerm',
    termDuration: { days: periodDays },
  } as unknown as VestingModeConfig;

  return {
    streamId: opts.streamId,
    sender: opts.payer,
    recipient: opts.payee,
    totalDeposited: total,
    startTime: opts.startTime,
    endTime,
    vestingMode,
    instrumentRef: opts.instrumentRef,
    cancellable: opts.cancellable ?? true,
    settlementMode: SettlementMode.TokenStandardCustody,
    assetType: AssetType.GlobalCip56,
    escrowOperator: opts.escrowOperator,
  };
}

export interface UsageBillingFlowOptions {
  readonly streamId: string;
  readonly payer: string;
  readonly payee: string;
  /**
   * Per-unit price (e.g. CC per 1000 RPC calls). Used as `flowRate`
   * over scaled time; for true usage-based billing the service provider
   * pauses and resumes the flow as actual consumption is metered.
   */
  readonly pricePerUnitPerSecond: Decimal | string | number;
  readonly startTime: Date;
  /** Initial funded balance. Customer must top-up to extend. */
  readonly initialFundedAmount: Decimal | string | number;
  readonly initialFundingReference: string;
  readonly instrumentRef: InstrumentRef;
  readonly escrowOperator: string;
}

/**
 * Construct a StreamFlow-shaped params record for the usage-based
 * billing model. Returns a plain object that maps onto the StreamFlow
 * Daml template's create arguments.
 *
 * Note: StreamFlow is a separate template from StreamEscrow, so we
 * return a different params shape here (not CreateStreamParams). The
 * SDK's flow-side create helper (to be added under
 * `commands/createFlow.ts`) consumes this directly.
 */
export interface FlowCreateParams {
  readonly streamId: string;
  readonly sender: string;
  readonly recipient: string;
  readonly escrowOperator: string;
  readonly instrumentRef: InstrumentRef;
  readonly flowRate: Decimal; // tokens per microsecond
  readonly startTime: Date;
  readonly initialFundedAmount: Decimal;
  readonly fundingReference: string;
}

export function buildUsageBillingFlow(opts: UsageBillingFlowOptions): FlowCreateParams {
  // pricePerUnitPerSecond → tokens per microsecond
  const tokensPerMicro = new Decimal(opts.pricePerUnitPerSecond).div(1_000_000);
  return {
    streamId: opts.streamId,
    sender: opts.payer,
    recipient: opts.payee,
    escrowOperator: opts.escrowOperator,
    instrumentRef: opts.instrumentRef,
    flowRate: tokensPerMicro,
    startTime: opts.startTime,
    initialFundedAmount: new Decimal(opts.initialFundedAmount),
    fundingReference: opts.initialFundingReference,
  };
}
