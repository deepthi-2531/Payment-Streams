/**
 * @module helpers/vesting
 *
 * High-level vesting-stream helper for the canonical Lumens.fi-shape
 * use case (employee / advisor / investor unlock schedules).
 *
 * Builds a fully-shaped `CreateStreamParams` payload from a small set
 * of vesting-specific inputs, with sensible defaults that match the
 * canonical pattern (CliffLinear, prefunded, TokenStandardCustody, not
 * cancellable by sender after cliff).
 *
 * The helper does not submit the create — it returns the params so the
 * caller can route through their CIP-103 Provider (recipient-side) or
 * vault-backed service (treasury-side) to actually submit.
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

/**
 * Vesting style. `cliffLinear` is the default; `linear` for cliffless;
 * `stepped` for tranche-based unlocks at fixed intervals.
 */
export type VestingStyle = 'cliffLinear' | 'linear' | 'stepped';

export interface VestingStreamOptions {
  /** Caller-supplied unique id for the stream. */
  readonly streamId: string;
  /** Vesting agent / treasury party funding the stream. */
  readonly sender: string;
  /** Beneficiary party receiving the vested amount. */
  readonly recipient: string;
  /** Total amount to vest, in the asset's smallest unit (as Decimal). */
  readonly totalAmount: Decimal | string | number;
  /** When vesting begins (employee start date, grant date, etc.). */
  readonly startTime: Date;
  /** Total vesting duration in days. Defaults to 365 (1 year). */
  readonly durationDays?: number;
  /** Cliff duration in days. Defaults to 90 (3-month cliff). */
  readonly cliffDays?: number;
  /** Vesting style. Defaults to `cliffLinear`. */
  readonly style?: VestingStyle;
  /** For `stepped` style: how many tranches; defaults to 4 (quarterly). */
  readonly steps?: number;
  /** Asset reference. CC or USDCx typically. */
  readonly instrumentRef: InstrumentRef;
  /** Escrow operator party (custody operator). */
  readonly escrowOperator: string;
  /** Sender-side funding reference from the wallet's V2 allocation step. */
  readonly fundingReference: string;
  /** Sender custody account. Defaults to `{ owner: sender, id: '' }`. */
  readonly senderAccount?: LedgerRecord;
  /** Recipient account for withdrawals. Defaults to `{ owner: recipient, id: '' }`. */
  readonly recipientAccount?: LedgerRecord;
  /** Whether the sender (vesting agent) can cancel. Defaults to false. */
  readonly cancellable?: boolean;
}

/**
 * Construct a CreateStreamParams payload for the vesting use case.
 *
 * Defaults align with the typical employment-vesting pattern:
 *   - 1-year total duration
 *   - 3-month (90-day) cliff
 *   - CliffLinear vesting after the cliff
 *   - Prefunded escrow (full amount locked at creation)
 *   - TokenStandardCustody settlement
 *   - Not cancellable by sender (recipient's accrued portion is theirs)
 */
export function buildVestingStream(opts: VestingStreamOptions): CreateStreamParams {
  const durationDays = opts.durationDays ?? 365;
  const cliffDays = opts.cliffDays ?? 90;
  const style = opts.style ?? 'cliffLinear';
  const total = new Decimal(opts.totalAmount);

  if (!total.isFinite() || total.lte(0)) {
    throw new Error('Vesting totalAmount must be > 0');
  }
  if (durationDays <= 0) {
    throw new Error('Vesting durationDays must be > 0 (endTime must be after startTime)');
  }
  if (style === 'cliffLinear' && cliffDays <= 0) {
    throw new Error('CliffLinear vesting requires cliffDays > 0');
  }
  if (style === 'cliffLinear' && cliffDays >= durationDays) {
    throw new Error(`Vesting cliff (${cliffDays}d) must be shorter than total duration (${durationDays}d)`);
  }
  if (style === 'stepped' && (opts.steps ?? 4) < 1) {
    throw new Error('Stepped vesting requires at least 1 step');
  }

  const endTime = new Date(opts.startTime.getTime() + durationDays * DAY_MS);
  const cliffTime = new Date(opts.startTime.getTime() + cliffDays * DAY_MS);

  let vestingMode: VestingModeConfig;
  switch (style) {
    case 'linear':
      vestingMode = { mode: VestingMode.Linear };
      break;
    case 'stepped': {
      const steps = opts.steps ?? 4;
      const stepInterval = Math.floor((durationDays * DAY_MICROS) / steps);
      if (stepInterval < 1) {
        throw new Error('Stepped vesting interval must be at least 1 microsecond');
      }
      vestingMode = {
        mode: VestingMode.Stepped,
        stepInterval,
        amountPerStep: total.div(steps),
      };
      break;
    }
    case 'cliffLinear':
    default:
      vestingMode = { mode: VestingMode.CliffLinear, cliffTime };
  }

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
