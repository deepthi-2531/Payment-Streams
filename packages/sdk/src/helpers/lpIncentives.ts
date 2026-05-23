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

import { SettlementMode, AssetType } from '../types/stream.js';
import type {
  CreateStreamParams,
  InstrumentRef,
  VestingModeConfig,
} from '../types/stream.js';

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
  const endTime = new Date(opts.startTime.getTime() + durationDays * 24 * 60 * 60 * 1000);
  const total = new Decimal(opts.rewardAmount);

  const vestingMode: VestingModeConfig = opts.renewable
    ? ({
        kind: 'RenewableTerm',
        termDuration: { days: durationDays },
      } as unknown as VestingModeConfig)
    : ({ kind: 'Linear' } as unknown as VestingModeConfig);

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
  };
}
