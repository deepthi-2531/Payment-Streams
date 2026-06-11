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

import { SettlementMode, AssetType, VestingMode } from '../types/stream.js';
import type {
  CreateStreamParams,
  InstrumentRef,
  LedgerRecord,
  VestingModeConfig,
} from '../types/stream.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_MICROS = 86_400_000_000; // one day as Daml RelTime microseconds

/** Default V2 account record for a bare party. */
function partyAccount(owner: string): LedgerRecord {
  return { owner, id: '' };
}

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
  /** Payer-side funding reference from the wallet's V2 allocation step. */
  readonly fundingReference: string;
  /** Payer custody account. Defaults to `{ owner: payer, id: '' }`. */
  readonly senderAccount?: LedgerRecord;
  /** Payee account for withdrawals. Defaults to `{ owner: payee, id: '' }`. */
  readonly recipientAccount?: LedgerRecord;
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
  const perPeriod = new Decimal(opts.amountPerPeriod);

  if (!perPeriod.isFinite() || perPeriod.lte(0)) {
    throw new Error('amountPerPeriod must be > 0');
  }
  if (periodDays <= 0) {
    throw new Error('periodDays must be > 0 (endTime must be after startTime)');
  }
  if (totalPeriods < 1) {
    throw new Error('totalPeriods must be at least 1');
  }

  const total = perPeriod.mul(totalPeriods);
  const endTime = new Date(opts.startTime.getTime() + totalPeriods * periodDays * DAY_MS);

  const vestingMode: VestingModeConfig = {
    mode: VestingMode.RenewableTerm,
    termDuration: Math.floor(periodDays * DAY_MICROS),
  };

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
    fundingReference: opts.fundingReference,
    senderAccount: opts.senderAccount ?? partyAccount(opts.payer),
    recipientAccount: opts.recipientAccount ?? partyAccount(opts.payee),
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
  /** Settlement reference for the initial funding leg. */
  readonly initialFundingReference: string;
  readonly instrumentRef: InstrumentRef;
  readonly escrowOperator: string;
  /** Additional observer parties on the flow contract. */
  readonly observers?: readonly string[];
}

/**
 * Create-time params for the `StreamFlow` Daml template
 * (`CantonStreams.Stream.StreamFlow`). Field names mirror the template;
 * the SDK flow create command (`commands/flow.ts`) fills the remaining
 * creation defaults (totalWithdrawn = 0, status = FlowActive,
 * pausedAt = None, cumulativePausedDuration = 0, numIterations = 0).
 */
export interface FlowCreateParams {
  readonly streamId: string;
  readonly sender: string;
  readonly recipient: string;
  readonly escrowOperator: string;
  readonly instrumentRef: InstrumentRef;
  /** Tokens per microsecond. Must be > 0 (template `ensure`). */
  readonly flowRate: Decimal;
  readonly startTime: Date;
  /** Initial funded balance; grows via TopUp_Flow. Must be >= 0. */
  readonly fundedAmount: Decimal;
  /** Settlement reference recorded for the initial funding leg. */
  readonly lastSettlementReference?: string;
  readonly observers: readonly string[];
}

/**
 * Construct a StreamFlow-shaped params record for the usage-based
 * billing model.
 *
 * Note: StreamFlow is a separate template from StreamEscrow, so we
 * return a different params shape here (not CreateStreamParams).
 */
export function buildUsageBillingFlow(opts: UsageBillingFlowOptions): FlowCreateParams {
  const pricePerSecond = new Decimal(opts.pricePerUnitPerSecond);
  if (!pricePerSecond.isFinite() || pricePerSecond.lte(0)) {
    throw new Error('pricePerUnitPerSecond must be > 0');
  }
  const funded = new Decimal(opts.initialFundedAmount);
  if (!funded.isFinite() || funded.isNegative()) {
    throw new Error('initialFundedAmount must be >= 0');
  }

  return {
    streamId: opts.streamId,
    sender: opts.payer,
    recipient: opts.payee,
    escrowOperator: opts.escrowOperator,
    instrumentRef: opts.instrumentRef,
    // pricePerUnitPerSecond → tokens per microsecond
    flowRate: pricePerSecond.div(1_000_000),
    startTime: opts.startTime,
    fundedAmount: funded,
    lastSettlementReference: opts.initialFundingReference,
    observers: opts.observers ?? [],
  };
}
