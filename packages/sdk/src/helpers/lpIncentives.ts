/**
 * @module helpers/lpIncentives
 *
 * High-level LP-incentive helper for the canonical BitDynamics-shape
 * use case (liquidity provider reward streams, market-maker retainers,
 * partner reward schedules).
 *
 * Builds CreateStreamParams payloads for a single LP recipient. Use
 * with batch create helpers to fan out across many LP wallets at once.
 *
 * Defaults: Linear vesting over a fixed campaign window, prefunded
 * (treasury commits the full campaign budget at creation), not
 * cancellable mid-campaign by the treasury (LPs need confidence the
 * rewards are reserved).
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

export interface IncentiveStreamOptions {
  /** Caller-supplied unique id for this LP stream. */
  readonly streamId: string;
  /** Treasury party funding the campaign. */
  readonly sender: string;
  /** LP recipient party. */
  readonly recipient: string;
  /** LP's share of the campaign rewards (in asset's smallest unit). */
  readonly rewardAmount: Decimal | string | number;
  /** When the campaign begins. */
  readonly startTime: Date;
  /** Campaign duration in days. Defaults to 30. */
  readonly durationDays?: number;
  /** Reward token (CC, USDCx, project token, etc.). */
  readonly instrumentRef: InstrumentRef;
  /** Escrow operator party. */
  readonly escrowOperator: string;
  /** Sender-side funding reference from the wallet's V2 allocation step. */
  readonly fundingReference: string;
  /** Sender custody account. Defaults to `{ owner: sender, id: '' }`. */
  readonly senderAccount?: LedgerRecord;
  /** Recipient account for withdrawals. Defaults to `{ owner: recipient, id: '' }`. */
  readonly recipientAccount?: LedgerRecord;
  /**
   * If true, the campaign auto-renews into a new term after expiry
   * (sender can extend by exercising Renew). Defaults to false.
   */
  readonly renewable?: boolean;
  /**
   * If true, the treasury can cancel mid-campaign (e.g. emergency stop).
   * Defaults to false — LPs need to trust the campaign won't be revoked
   * after they've committed liquidity.
   */
  readonly cancellable?: boolean;
}

/**
 * Construct CreateStreamParams for a single LP-incentive stream.
 *
 * For 1000+ LP campaigns, call this in a loop and submit via
 * `BatchCreate` for atomic multi-recipient creation.
 */
export function buildIncentiveStream(opts: IncentiveStreamOptions): CreateStreamParams {
  const durationDays = opts.durationDays ?? 30;
  const total = new Decimal(opts.rewardAmount);

  if (!total.isFinite() || total.lte(0)) {
    throw new Error('Incentive rewardAmount must be > 0');
  }
  if (durationDays <= 0) {
    throw new Error('Campaign durationDays must be > 0 (endTime must be after startTime)');
  }

  const endTime = new Date(opts.startTime.getTime() + durationDays * DAY_MS);

  const vestingMode: VestingModeConfig = opts.renewable
    ? {
        mode: VestingMode.RenewableTerm,
        termDuration: Math.floor(durationDays * DAY_MICROS),
      }
    : { mode: VestingMode.Linear };

  return {
    streamId: opts.streamId,
    sender: opts.sender,
    recipient: opts.recipient,
    totalDeposited: total,
    startTime: opts.startTime,
    endTime,
    vestingMode,
    instrumentRef: opts.instrumentRef,
    cancellable: opts.cancellable ?? false,
    settlementMode: SettlementMode.TokenStandardCustody,
    assetType: AssetType.GlobalCip56,
    escrowOperator: opts.escrowOperator,
    fundingReference: opts.fundingReference,
    senderAccount: opts.senderAccount ?? partyAccount(opts.sender),
    recipientAccount: opts.recipientAccount ?? partyAccount(opts.recipient),
  };
}
