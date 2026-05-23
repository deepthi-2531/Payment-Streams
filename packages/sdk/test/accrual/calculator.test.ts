import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  linearAccrual,
  cliffLinearAccrual,
  steppedAccrual,
  withdrawable,
  refundable,
  getBalances,
} from '../../src/accrual/calculator.js';
import { VestingMode, StreamStatus, AssetType } from '../../src/types/stream.js';
import type { Stream } from '../../src/types/stream.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a Date from an offset in milliseconds from a base epoch. */
const base = new Date('2025-01-01T00:00:00Z').getTime();
const t = (offsetMs: number) => new Date(base + offsetMs);

/** Shorthand Decimal constructor. */
const d = (v: Decimal.Value) => new Decimal(v);

/** Build a minimal Stream object for getBalances tests. */
function makeStream(overrides: {
  totalDeposited?: Decimal;
  startTime?: Date;
  endTime?: Date;
  vestingMode?: Stream['config']['vestingMode'];
  totalWithdrawn?: Decimal;
  status?: StreamStatus;
  cancellable?: boolean;
}): Stream {
  return {
    contractId: 'test-contract-001',
    config: {
      streamId: 'test-stream-001',
      sender: 'alice',
      recipient: 'bob',
      totalDeposited: overrides.totalDeposited ?? d('1000'),
      startTime: overrides.startTime ?? t(0),
      endTime: overrides.endTime ?? t(10_000),
      vestingMode: overrides.vestingMode ?? { mode: VestingMode.Linear },
      assetType: AssetType.GlobalCip56,
      cancellable: overrides.cancellable ?? true,
    },
    state: {
      totalWithdrawn: overrides.totalWithdrawn ?? d('0'),
      status: overrides.status ?? StreamStatus.Active,
      renewalCount: 0,
    },
  };
}

// ===========================================================================
// linearAccrual
// ===========================================================================

describe('linearAccrual', () => {
  const deposit = d('1000');
  const start = t(0);
  const end = t(10_000);

  it('returns 0 at start time', () => {
    const result = linearAccrual(deposit, start, end, start);
    expect(result.toNumber()).toBe(0);
  });

  it('returns full deposit at end time', () => {
    const result = linearAccrual(deposit, start, end, end);
    expect(result.equals(deposit)).toBe(true);
  });

  it('returns 50% at midpoint', () => {
    const mid = t(5_000);
    const result = linearAccrual(deposit, start, end, mid);
    expect(result.toNumber()).toBe(500);
  });

  it('returns 0 before start time', () => {
    const before = t(-1_000);
    const result = linearAccrual(deposit, start, end, before);
    expect(result.toNumber()).toBe(0);
  });

  it('returns full deposit after end time', () => {
    const after = t(20_000);
    const result = linearAccrual(deposit, start, end, after);
    expect(result.equals(deposit)).toBe(true);
  });

  it('returns 25% at quarter mark', () => {
    const quarter = t(2_500);
    const result = linearAccrual(deposit, start, end, quarter);
    expect(result.toNumber()).toBe(250);
  });

  it('preserves fractional token precision with ROUND_DOWN', () => {
    // Math.floor(10_000 / 3) = 3333ms
    // elapsed_μs = 3333 * 1000 = 3_333_000
    // duration_μs = 10000 * 1000 = 10_000_000
    // accrued = 1000 * 3_333_000 / 10_000_000 = 333.3
    const oneThird = t(Math.floor(10_000 / 3));
    const result = linearAccrual(deposit, start, end, oneThird);
    expect(result.equals(d('333.3'))).toBe(true);
  });

  it('supports sub-token streams without flooring to whole units', () => {
    const fractionalDeposit = d('1');
    const halfway = t(5_000);
    const result = linearAccrual(fractionalDeposit, start, end, halfway);

    expect(result.equals(d('0.5'))).toBe(true);
  });
});

// ===========================================================================
// cliffLinearAccrual
// ===========================================================================

describe('cliffLinearAccrual', () => {
  const deposit = d('1000');
  const start = t(0);
  const end = t(10_000);
  const cliffTime = t(2_000);

  it('returns 0 before cliff', () => {
    const before = t(1_000);
    const result = cliffLinearAccrual(deposit, start, end, cliffTime, before);
    expect(result.toNumber()).toBe(0);
  });

  it('returns linear accrual at cliff time (all accrued-so-far unlocks)', () => {
    // At cliffTime (2000ms), linearAccrual would be 1000 * 2000/10000 = 200
    const result = cliffLinearAccrual(deposit, start, end, cliffTime, cliffTime);
    expect(result.toNumber()).toBe(200);
  });

  it('returns linear accrual after cliff', () => {
    const afterCliff = t(6_000);
    // linearAccrual(1000, 0, 10000, 6000) = 1000 * 6000/10000 = 600
    const result = cliffLinearAccrual(deposit, start, end, cliffTime, afterCliff);
    expect(result.toNumber()).toBe(600);
  });

  it('returns full deposit at end time', () => {
    const result = cliffLinearAccrual(deposit, start, end, cliffTime, end);
    expect(result.equals(deposit)).toBe(true);
  });

  it('returns full deposit after end time', () => {
    const after = t(20_000);
    const result = cliffLinearAccrual(deposit, start, end, cliffTime, after);
    expect(result.equals(deposit)).toBe(true);
  });

  it('returns 0 at start time (before cliff)', () => {
    const result = cliffLinearAccrual(deposit, start, end, cliffTime, start);
    expect(result.toNumber()).toBe(0);
  });

  it('returns 0 just before cliff', () => {
    // 1ms before cliff should still be 0
    const justBefore = t(1_999);
    const result = cliffLinearAccrual(deposit, start, end, cliffTime, justBefore);
    expect(result.toNumber()).toBe(0);
  });

  it('returns 75% at 75% mark (after cliff)', () => {
    const atThreeQuarter = t(7_500);
    // linearAccrual(1000, 0, 10000, 7500) = 750
    const result = cliffLinearAccrual(deposit, start, end, cliffTime, atThreeQuarter);
    expect(result.toNumber()).toBe(750);
  });
});

// ===========================================================================
// steppedAccrual
// ===========================================================================

describe('steppedAccrual', () => {
  const deposit = d('1000');
  const start = t(0);
  // stepInterval: 2_500ms = 2_500_000 microseconds, amountPerStep = 250
  // This gives 4 steps of 250 each = 1000 total
  const stepInterval = 2_500_000; // 2500ms in microseconds
  const amountPerStep = d('250');

  it('returns 0 at start', () => {
    const result = steppedAccrual(deposit, start, stepInterval, amountPerStep, start);
    expect(result.toNumber()).toBe(0);
  });

  it('returns 0 between start and first step boundary', () => {
    const mid = t(1_000); // before first step at 2500ms
    const result = steppedAccrual(deposit, start, stepInterval, amountPerStep, mid);
    expect(result.toNumber()).toBe(0);
  });

  it('returns one step amount at first step boundary', () => {
    const atFirstStep = t(2_500);
    const result = steppedAccrual(deposit, start, stepInterval, amountPerStep, atFirstStep);
    expect(result.toNumber()).toBe(250);
  });

  it('returns one step amount between first and second step', () => {
    const between = t(3_000);
    const result = steppedAccrual(deposit, start, stepInterval, amountPerStep, between);
    expect(result.toNumber()).toBe(250);
  });

  it('returns two steps at second boundary', () => {
    const atSecond = t(5_000);
    const result = steppedAccrual(deposit, start, stepInterval, amountPerStep, atSecond);
    expect(result.toNumber()).toBe(500);
  });

  it('returns three steps at third boundary', () => {
    const atThird = t(7_500);
    const result = steppedAccrual(deposit, start, stepInterval, amountPerStep, atThird);
    expect(result.toNumber()).toBe(750);
  });

  it('returns full deposit at fourth step (all steps complete)', () => {
    const atFourth = t(10_000);
    const result = steppedAccrual(deposit, start, stepInterval, amountPerStep, atFourth);
    expect(result.equals(deposit)).toBe(true);
  });

  it('caps at totalDeposited even if steps * amountPerStep would exceed it', () => {
    const after = t(20_000); // way past all steps
    const result = steppedAccrual(deposit, start, stepInterval, amountPerStep, after);
    expect(result.equals(deposit)).toBe(true);
  });

  it('returns 0 before start', () => {
    const before = t(-1_000);
    const result = steppedAccrual(deposit, start, stepInterval, amountPerStep, before);
    expect(result.toNumber()).toBe(0);
  });

  it('throws on stepInterval <= 0', () => {
    expect(() => steppedAccrual(deposit, start, 0, amountPerStep, t(5_000))).toThrow(
      'stepInterval must be > 0',
    );
    expect(() => steppedAccrual(deposit, start, -1, amountPerStep, t(5_000))).toThrow(
      'stepInterval must be > 0',
    );
  });

  it('works with non-even amountPerStep (caps at deposit)', () => {
    // 3 steps of 400 each = 1200 > deposit(1000), so capped at 1000
    const bigStep = d('400');
    const interval = 1_000_000; // 1s in microseconds
    const atThreeSteps = t(3_000);
    const result = steppedAccrual(deposit, start, interval, bigStep, atThreeSteps);
    // 3 * 400 = 1200 but capped at 1000
    expect(result.toNumber()).toBe(1000);
  });

  it('works with small amountPerStep', () => {
    const smallStep = d('1');
    const interval = 1_000_000; // 1s in microseconds
    const atFiveSteps = t(5_000);
    const result = steppedAccrual(deposit, start, interval, smallStep, atFiveSteps);
    // 5 * 1 = 5
    expect(result.toNumber()).toBe(5);
  });
});

// ===========================================================================
// withdrawable
// ===========================================================================

describe('withdrawable', () => {
  it('returns accrued minus withdrawn', () => {
    const result = withdrawable(d('500'), d('200'));
    expect(result.toNumber()).toBe(300);
  });

  it('returns 0 when fully withdrawn', () => {
    const result = withdrawable(d('500'), d('500'));
    expect(result.toNumber()).toBe(0);
  });

  it('returns 0 when withdrawn exceeds accrued (clamp)', () => {
    const result = withdrawable(d('100'), d('200'));
    expect(result.toNumber()).toBe(0);
  });

  it('handles zero accrued', () => {
    const result = withdrawable(d('0'), d('0'));
    expect(result.toNumber()).toBe(0);
  });
});

// ===========================================================================
// refundable
// ===========================================================================

describe('refundable', () => {
  it('returns deposit minus accrued', () => {
    const result = refundable(d('1000'), d('300'));
    expect(result.toNumber()).toBe(700);
  });

  it('returns 0 when fully accrued', () => {
    const result = refundable(d('1000'), d('1000'));
    expect(result.toNumber()).toBe(0);
  });

  it('returns 0 when accrued exceeds deposit (clamp)', () => {
    const result = refundable(d('100'), d('200'));
    expect(result.toNumber()).toBe(0);
  });

  it('returns full deposit when nothing accrued', () => {
    const result = refundable(d('1000'), d('0'));
    expect(result.toNumber()).toBe(1000);
  });
});

// ===========================================================================
// getBalances
// ===========================================================================

describe('getBalances', () => {
  describe('Linear vesting mode', () => {
    it('computes balances at midpoint', () => {
      const stream = makeStream({});
      const now = t(5_000); // midpoint of 0..10_000
      const bal = getBalances(stream, now);

      expect(bal.accrued.toNumber()).toBe(500);
      expect(bal.withdrawable.toNumber()).toBe(500);
      expect(bal.refundable.toNumber()).toBe(500);
      expect(bal.alreadyWithdrawn.toNumber()).toBe(0);
      expect(bal.percentComplete).toBe(50);
    });

    it('accounts for prior withdrawals', () => {
      const stream = makeStream({ totalWithdrawn: d('200') });
      const now = t(5_000);
      const bal = getBalances(stream, now);

      expect(bal.accrued.toNumber()).toBe(500);
      expect(bal.withdrawable.toNumber()).toBe(300);
      expect(bal.refundable.toNumber()).toBe(500);
      expect(bal.alreadyWithdrawn.toNumber()).toBe(200);
    });
  });

  describe('CliffLinear vesting mode', () => {
    it('returns 0 accrued before cliff', () => {
      const stream = makeStream({
        vestingMode: {
          mode: VestingMode.CliffLinear,
          cliffTime: t(2_000),
        },
      });
      const bal = getBalances(stream, t(1_000));
      expect(bal.accrued.toNumber()).toBe(0);
      expect(bal.withdrawable.toNumber()).toBe(0);
    });

    it('returns linear accrual at cliff time', () => {
      const stream = makeStream({
        vestingMode: {
          mode: VestingMode.CliffLinear,
          cliffTime: t(2_000),
        },
      });
      const bal = getBalances(stream, t(2_000));
      // linearAccrual(1000, 0, 10000, 2000) = 200
      expect(bal.accrued.toNumber()).toBe(200);
    });
  });

  describe('Stepped vesting mode', () => {
    it('returns stepped accrual', () => {
      const stream = makeStream({
        vestingMode: {
          mode: VestingMode.Stepped,
          stepInterval: 2_500_000, // 2500ms in microseconds
          amountPerStep: d('250'),
        },
      });
      // At 3000ms with steps at 2500ms intervals -> 1 step done = 250
      const bal = getBalances(stream, t(3_000));
      expect(bal.accrued.toNumber()).toBe(250);
    });

    it('returns multiple steps', () => {
      const stream = makeStream({
        vestingMode: {
          mode: VestingMode.Stepped,
          stepInterval: 2_500_000,
          amountPerStep: d('250'),
        },
      });
      // At 5000ms -> 2 steps done = 500
      const bal = getBalances(stream, t(5_000));
      expect(bal.accrued.toNumber()).toBe(500);
    });
  });

  describe('RenewableTerm vesting mode', () => {
    it('uses linear accrual', () => {
      const stream = makeStream({
        vestingMode: {
          mode: VestingMode.RenewableTerm,
          termDuration: 10_000_000, // 10s in microseconds
        },
      });
      const bal = getBalances(stream, t(5_000));
      expect(bal.accrued.toNumber()).toBe(500);
    });
  });

  describe('Completed stream', () => {
    it('returns fully accrued balances', () => {
      const stream = makeStream({
        status: StreamStatus.Completed,
        totalWithdrawn: d('800'),
      });
      const bal = getBalances(stream, t(5_000));

      expect(bal.accrued.toNumber()).toBe(1000);
      expect(bal.withdrawable.toNumber()).toBe(200);
      expect(bal.refundable.toNumber()).toBe(0);
      expect(bal.alreadyWithdrawn.toNumber()).toBe(800);
      expect(bal.percentComplete).toBe(100);
    });
  });

  describe('Cancelled stream', () => {
    it('returns frozen balances', () => {
      const stream = makeStream({
        status: StreamStatus.Cancelled,
        totalWithdrawn: d('300'),
      });
      const bal = getBalances(stream, t(5_000));

      expect(bal.accrued.toNumber()).toBe(300);
      expect(bal.withdrawable.toNumber()).toBe(0);
      expect(bal.refundable.toNumber()).toBe(0);
      expect(bal.alreadyWithdrawn.toNumber()).toBe(300);
      expect(bal.percentComplete).toBe(100);
    });
  });

  describe('percentComplete', () => {
    it('is 0 before start', () => {
      const stream = makeStream({});
      const bal = getBalances(stream, t(-1_000));
      expect(bal.percentComplete).toBe(0);
    });

    it('is 100 after end', () => {
      const stream = makeStream({});
      const bal = getBalances(stream, t(20_000));
      expect(bal.percentComplete).toBe(100);
    });
  });
});
