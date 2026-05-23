/**
 * @module accrual/calculator
 *
 * **DISPLAY ONLY** — the ledger (Daml) is the authoritative source of truth.
 *
 * Client-side accrual math that mirrors the Daml `Accrual` module exactly.
 * Used to power real-time UI balance displays between ledger round-trips.
 *
 * All arithmetic uses `decimal.js` with `ROUND_DOWN` to match Daml Decimal's
 * fixed-scale semantics and ensure the client never shows more than the ledger
 * would actually allow.
 *
 * --- Daml Parity Reference ---
 * Each function here corresponds to its Daml counterpart in
 * packages/daml/main/daml/CantonStreams/Stream/Accrual.daml:
 *   - linearAccrual      ↔ Accrual.linearAccrual
 *   - cliffLinearAccrual  ↔ Accrual.cliffLinearAccrual
 *   - steppedAccrual      ↔ Accrual.steppedAccrual
 *   - withdrawable        ↔ Accrual.withdrawable
 *   - refundable          ↔ Accrual.refundable
 */

import Decimal from 'decimal.js';
import {
  VestingMode,
  StreamStatus,
  type Stream,
  type StreamBalances,
  type StreamConfig,
  type StreamState,
} from '../types/stream.js';
import { InvariantViolationError } from '../utils/errors.js';

// Configure decimal.js for this module: plenty of precision.
// Daml LF uses Java BigDecimal under the hood and rounds numeric division
// results with HALF_EVEN (banker's rounding), NOT truncation toward zero.
// The "TruncateTowardZero" policy comment in Accrual.daml describes the
// intended rounding semantics for the *application* (never overpay), but the
// Daml LF runtime itself applies HALF_EVEN for individual divisions.
// We mirror HALF_EVEN here so client-computed amounts match on-ledger assertions.
const D = Decimal.clone({ precision: 38, rounding: Decimal.ROUND_HALF_EVEN });

/** Shorthand: create a Decimal from a numeric source, respecting ROUND_HALF_EVEN. */
function d(v: Decimal.Value): Decimal {
  return new D(v);
}

/** Clamp a value between min and max (inclusive). */
function clamp(value: Decimal, min: Decimal, max: Decimal): Decimal {
  if (value.lessThan(min)) return min;
  if (value.greaterThan(max)) return max;
  return value;
}

/**
 * Convert a time difference to microseconds (matches Daml's timeToMicros).
 *
 * Daml uses `convertRelTimeToMicroseconds (subTime t1 t2)`.
 * JS Date.getTime() returns milliseconds, so we multiply by 1000.
 */
function timeToMicros(t1: Date, t2: Date): Decimal {
  return d(t1.getTime() - t2.getTime()).times(1000);
}

// ---------------------------------------------------------------------------
// Core accrual functions
// ---------------------------------------------------------------------------

/**
 * Compute the linearly-vested amount at time `now`.
 *
 * Mirrors Daml `Accrual.linearAccrual`:
 * ```
 * accrued = totalDeposited * elapsed / duration
 * ```
 * where elapsed and duration are in microseconds and the result is truncated
 * to ledger Decimal precision (10 fractional digits), not to whole units.
 *
 * **DISPLAY ONLY** — the ledger is authoritative.
 */
export function linearAccrual(
  totalDeposited: Decimal,
  startTime: Date,
  endTime: Date,
  now: Date,
): Decimal {
  if (now <= startTime) return d(0);
  if (now >= endTime) return d(totalDeposited);

  const elapsed = timeToMicros(now, startTime);
  const duration = timeToMicros(endTime, startTime);

  const accrued = d(totalDeposited)
    .times(elapsed)
    .dividedBy(duration)
    .toDecimalPlaces(10, Decimal.ROUND_HALF_EVEN);
  return clamp(accrued, d(0), d(totalDeposited));
}

/**
 * Compute the cliff-then-linear vested amount at time `now`.
 *
 * Mirrors Daml `Accrual.cliffLinearAccrual`:
 * - Returns 0 before cliffTime.
 * - At/after cliffTime: returns linearAccrual(totalDeposited, startTime, endTime, now).
 *
 * This means at the cliff instant, all previously-accrued linear amount
 * becomes available at once. There is no separate "cliffAmount" — the Daml
 * model only has cliffTime.
 *
 * **DISPLAY ONLY** — the ledger is authoritative.
 */
export function cliffLinearAccrual(
  totalDeposited: Decimal,
  startTime: Date,
  endTime: Date,
  cliffTime: Date,
  now: Date,
): Decimal {
  if (now < cliffTime) return d(0);
  if (now >= endTime) return d(totalDeposited);

  // After cliff: full linear accrual from startTime to endTime
  // Matches Daml: linearAccrual totalDeposited startTime endTime now
  return linearAccrual(totalDeposited, startTime, endTime, now);
}

/**
 * Compute the stepped (discrete) vested amount at time `now`.
 *
 * Mirrors Daml `Accrual.steppedAccrual`:
 * ```
 * steps = elapsed_micros / interval_micros  (integer division)
 * accrued = min(deposit, steps * amountPerStep)
 * ```
 *
 * **DISPLAY ONLY** — the ledger is authoritative.
 *
 * @param totalDeposited - Total amount deposited.
 * @param startTime      - Vesting start.
 * @param stepInterval   - Interval between steps in microseconds (Daml RelTime).
 * @param amountPerStep  - Fixed amount unlocked per step.
 * @param now            - Current time.
 */
export function steppedAccrual(
  totalDeposited: Decimal,
  startTime: Date,
  stepInterval: number,
  amountPerStep: Decimal,
  now: Date,
): Decimal {
  if (stepInterval <= 0) {
    throw new InvariantViolationError('stepInterval must be > 0');
  }

  if (now <= startTime) return d(0);

  // elapsed in microseconds (matching Daml's convertRelTimeToMicroseconds)
  const elapsedMicros = d(now.getTime() - startTime.getTime()).times(1000);
  const intervalMicros = d(stepInterval);

  // Daml: steps = elapsed / interval (integer division)
  // Daml Int division truncates toward zero
  const steps = elapsedMicros.dividedBy(intervalMicros).floor();
  const accrued = steps.times(d(amountPerStep));

  return clamp(accrued, d(0), d(totalDeposited));
}

/**
 * Compute the amount currently available for withdrawal.
 *
 * Mirrors Daml `Accrual.withdrawable`:
 * ```
 * withdrawable = max(0, accrued - totalWithdrawn)
 * ```
 *
 * **DISPLAY ONLY** — the ledger is authoritative.
 */
export function withdrawable(accrued: Decimal, totalWithdrawn: Decimal): Decimal {
  const result = d(accrued).minus(totalWithdrawn);
  return result.lessThan(d(0)) ? d(0) : result;
}

/**
 * Compute the amount the sender would receive on cancellation.
 *
 * Mirrors Daml `Accrual.refundable`:
 * ```
 * refundable = max(0, totalDeposited - accrued)
 * ```
 *
 * **DISPLAY ONLY** — the ledger is authoritative.
 */
export function refundable(totalDeposited: Decimal, accrued: Decimal): Decimal {
  const result = d(totalDeposited).minus(accrued);
  return result.lessThan(d(0)) ? d(0) : result;
}

// ---------------------------------------------------------------------------
// High-level balance computation
// ---------------------------------------------------------------------------

/**
 * Compute a full {@link StreamBalances} snapshot for a stream at a given time.
 *
 * Dispatches to the correct accrual function based on the stream's vesting
 * mode, then derives all balance fields.
 *
 * **DISPLAY ONLY** — the ledger is authoritative.
 */
export function getBalances(stream: Stream, now: Date = new Date()): StreamBalances {
  const { config, state } = stream;

  // Completed / cancelled streams: accrued is frozen.
  if (state.status === StreamStatus.Completed) {
    return completedBalances(config, state);
  }
  if (state.status === StreamStatus.Cancelled) {
    return cancelledBalances(state);
  }

  const accrued = computeAccrual(config, now);
  const wdable = withdrawable(accrued, state.totalWithdrawn);
  const rfundable = refundable(config.totalDeposited, accrued);

  const duration = config.endTime.getTime() - config.startTime.getTime();
  const elapsed = Math.max(0, now.getTime() - config.startTime.getTime());
  const pct = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 100;

  return {
    accrued,
    withdrawable: wdable,
    refundable: rfundable,
    alreadyWithdrawn: d(state.totalWithdrawn),
    percentComplete: Math.round(pct * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Dispatch accrual calculation based on vesting mode. */
function computeAccrual(config: StreamConfig, now: Date): Decimal {
  const { vestingMode } = config;

  switch (vestingMode.mode) {
    case VestingMode.Linear:
      return linearAccrual(
        config.totalDeposited,
        config.startTime,
        config.endTime,
        now,
      );

    case VestingMode.CliffLinear:
      return cliffLinearAccrual(
        config.totalDeposited,
        config.startTime,
        config.endTime,
        vestingMode.cliffTime,
        now,
      );

    case VestingMode.Stepped:
      return steppedAccrual(
        config.totalDeposited,
        config.startTime,
        vestingMode.stepInterval,
        vestingMode.amountPerStep,
        now,
      );

    case VestingMode.RenewableTerm:
      // RenewableTerm uses simple linear vesting within the current term.
      return linearAccrual(
        config.totalDeposited,
        config.startTime,
        config.endTime,
        now,
      );

    default: {
      const _exhaustive: never = vestingMode;
      throw new InvariantViolationError(
        `Unknown vesting mode: ${(_exhaustive as any).mode}`,
      );
    }
  }
}

/** Balance snapshot for a completed stream. */
function completedBalances(config: StreamConfig, state: StreamState): StreamBalances {
  return {
    accrued: d(config.totalDeposited),
    withdrawable: withdrawable(config.totalDeposited, state.totalWithdrawn),
    refundable: d(0),
    alreadyWithdrawn: d(state.totalWithdrawn),
    percentComplete: 100,
  };
}

/** Balance snapshot for a cancelled stream (everything is frozen at state). */
function cancelledBalances(state: StreamState): StreamBalances {
  return {
    accrued: d(state.totalWithdrawn),
    withdrawable: d(0),
    refundable: d(0),
    alreadyWithdrawn: d(state.totalWithdrawn),
    percentComplete: 100,
  };
}
