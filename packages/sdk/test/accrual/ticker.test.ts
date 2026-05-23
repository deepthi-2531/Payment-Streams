import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import { BalanceTicker } from '../../src/accrual/ticker.js';
import { VestingMode, StreamStatus } from '../../src/types/stream.js';
import type { Stream, StreamBalances } from '../../src/types/stream.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const d = (v: Decimal.Value) => new Decimal(v);

function makeStream(): Stream {
  const now = Date.now();
  return {
    contractId: 'ticker-contract-001',
    config: {
      streamId: 'ticker-stream-001',
      sender: 'alice',
      recipient: 'bob',
      totalDeposited: d('1000'),
      startTime: new Date(now - 5_000), // started 5s ago
      endTime: new Date(now + 5_000),   // ends 5s from now
      vestingMode: { mode: VestingMode.Linear },
      cancellable: true,
    },
    state: {
      totalWithdrawn: d('0'),
      status: StreamStatus.Active,
      renewalCount: 0,
    },
  };
}

// ===========================================================================
// BalanceTicker
// ===========================================================================

describe('BalanceTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws RangeError for non-positive intervalMs', () => {
    expect(() => new BalanceTicker(makeStream(), 0)).toThrow(RangeError);
    expect(() => new BalanceTicker(makeStream(), -100)).toThrow(RangeError);
  });

  it('is not running before start()', () => {
    const ticker = new BalanceTicker(makeStream());
    expect(ticker.isRunning).toBe(false);
  });

  it('is running after start()', () => {
    const ticker = new BalanceTicker(makeStream());
    ticker.start();
    expect(ticker.isRunning).toBe(true);
    ticker.stop();
  });

  it('is not running after stop()', () => {
    const ticker = new BalanceTicker(makeStream());
    ticker.start();
    ticker.stop();
    expect(ticker.isRunning).toBe(false);
  });

  it('stop() is safe to call multiple times', () => {
    const ticker = new BalanceTicker(makeStream());
    ticker.start();
    ticker.stop();
    ticker.stop(); // no error
    expect(ticker.isRunning).toBe(false);
  });

  it('start() is a no-op when already running', () => {
    const cb = vi.fn();
    const ticker = new BalanceTicker(makeStream(), 500);
    ticker.onTick(cb);
    ticker.start();
    expect(cb).toHaveBeenCalledTimes(1); // immediate tick

    ticker.start(); // no-op
    expect(cb).toHaveBeenCalledTimes(1); // should not re-emit

    ticker.stop();
  });

  it('emits an immediate tick on start()', () => {
    const cb = vi.fn();
    const ticker = new BalanceTicker(makeStream(), 1000);
    ticker.onTick(cb);
    ticker.start();

    expect(cb).toHaveBeenCalledTimes(1);
    const balances: StreamBalances = cb.mock.calls[0][0];
    expect(balances.accrued).toBeInstanceOf(Decimal);
    expect(typeof balances.percentComplete).toBe('number');

    ticker.stop();
  });

  it('emits ticks at the configured interval', () => {
    const cb = vi.fn();
    const ticker = new BalanceTicker(makeStream(), 500);
    ticker.onTick(cb);
    ticker.start();

    expect(cb).toHaveBeenCalledTimes(1); // immediate

    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(5);

    ticker.stop();
  });

  it('stops emitting after stop()', () => {
    const cb = vi.fn();
    const ticker = new BalanceTicker(makeStream(), 500);
    ticker.onTick(cb);
    ticker.start();
    expect(cb).toHaveBeenCalledTimes(1);

    ticker.stop();

    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1); // no more calls
  });

  it('supports multiple callbacks', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const ticker = new BalanceTicker(makeStream(), 1000);
    ticker.onTick(cb1).onTick(cb2);
    ticker.start();

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(cb1).toHaveBeenCalledTimes(2);
    expect(cb2).toHaveBeenCalledTimes(2);

    ticker.stop();
  });

  it('offTick removes a callback', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const ticker = new BalanceTicker(makeStream(), 500);
    ticker.onTick(cb1).onTick(cb2);
    ticker.start();

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    const removed = ticker.offTick(cb1);
    expect(removed).toBe(true);

    vi.advanceTimersByTime(500);
    expect(cb1).toHaveBeenCalledTimes(1); // no new call
    expect(cb2).toHaveBeenCalledTimes(2);

    ticker.stop();
  });

  it('offTick returns false for unknown callback', () => {
    const ticker = new BalanceTicker(makeStream());
    const result = ticker.offTick(() => {});
    expect(result).toBe(false);
  });

  it('swallows errors thrown by callbacks', () => {
    const badCb = vi.fn(() => {
      throw new Error('callback error');
    });
    const goodCb = vi.fn();

    const ticker = new BalanceTicker(makeStream(), 500);
    ticker.onTick(badCb).onTick(goodCb);
    ticker.start();

    // Both should have been called (bad one throws but good one still runs)
    expect(badCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);

    ticker.stop();
  });

  it('getCurrentBalances works without starting the ticker', () => {
    const stream = makeStream();
    const ticker = new BalanceTicker(stream);

    const balances = ticker.getCurrentBalances();
    expect(balances.accrued).toBeInstanceOf(Decimal);
    expect(balances.withdrawable).toBeInstanceOf(Decimal);
    expect(typeof balances.percentComplete).toBe('number');
  });

  it('getCurrentBalances accepts a custom time', () => {
    const stream = makeStream();
    const ticker = new BalanceTicker(stream);

    // Pass a time equal to the end time -> should be 100%
    const balances = ticker.getCurrentBalances(stream.config.endTime);
    expect(balances.percentComplete).toBe(100);
    expect(balances.accrued.equals(stream.config.totalDeposited)).toBe(true);
  });
});
