/**
 * accrualAt — pure function returning the amount accrued at a given wall-clock
 * timestamp for a `Stream` from the SDK.
 *
 * Used by display primitives (`VestingSparkline`, `AccrualChart`,
 * `VestingPreview`, `MonoCounter` callers). Backed by the same accrual
 * formulas the SDK uses server-side (`linearAccrual`, `cliffLinearAccrual`,
 * `steppedAccrual` from `@canton-streams/sdk`) — display values stay in
 * lockstep with what the ledger will compute.
 */
import Decimal from 'decimal.js';
import {
  linearAccrual,
  cliffLinearAccrual,
  steppedAccrual,
  VestingMode,
} from '@canton-streams/sdk/browser';
import type { Stream, StreamStatus, VestingModeConfig } from '@canton-streams/sdk/browser';

/**
 * Subset of `Stream` the chart primitives consume. Allows callers to pass
 * either a full `Stream` (production) or a `VestingPreview` virtual shape
 * (form-side preview before contract is created).
 */
export interface AccrualShape {
  readonly total: Decimal;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly vesting: VestingModeConfig;
  readonly status?: StreamStatus | string;
  readonly withdrawn?: Decimal;
}

/** Project a `Stream` into the chart-friendly shape. */
export function shapeFromStream(stream: Stream): AccrualShape {
  return {
    total: stream.config.totalDeposited,
    startTime: stream.config.startTime,
    endTime: stream.config.endTime,
    vesting: stream.config.vestingMode,
    status: stream.state.status,
    withdrawn: stream.state.totalWithdrawn,
  };
}

/** Returns accrued amount at time `t`. Pure, side-effect free. */
export function accrualAt(stream: AccrualShape, t: Date | number = Date.now()): Decimal {
  const tMs = typeof t === 'number' ? t : t.getTime();
  const tDate = new Date(tMs);

  if (stream.status === 'Cancelled') {
    return stream.withdrawn ?? new Decimal(0);
  }
  if (tMs <= stream.startTime.getTime()) return new Decimal(0);
  if (tMs >= stream.endTime.getTime() || stream.status === 'Completed') {
    return stream.total;
  }

  switch (stream.vesting.mode) {
    case VestingMode.Linear:
      return linearAccrual(stream.total, stream.startTime, stream.endTime, tDate);
    case VestingMode.CliffLinear:
      return cliffLinearAccrual(
        stream.total,
        stream.startTime,
        stream.endTime,
        stream.vesting.cliffTime,
        tDate,
      );
    case VestingMode.Stepped:
      return steppedAccrual(
        stream.total,
        stream.startTime,
        stream.vesting.stepInterval,
        stream.vesting.amountPerStep,
        tDate,
      );
    case VestingMode.RenewableTerm:
      // Mock + Daml both treat RenewableTerm as linear within the term.
      return linearAccrual(stream.total, stream.startTime, stream.endTime, tDate);
  }
}

/** Returns vesting progress in [0, 1] at time `t`. */
export function vestingProgressAt(
  stream: AccrualShape,
  t: Date | number = Date.now(),
): number {
  if (stream.total.lte(0)) return 0;
  return Math.max(
    0,
    Math.min(1, accrualAt(stream, t).div(stream.total).toNumber()),
  );
}
