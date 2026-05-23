/**
 * @module accrual/ticker
 *
 * Real-time balance ticker for driving UI updates.
 *
 * **DISPLAY ONLY** — the ledger (Daml) is the authoritative source of truth.
 * The ticker recalculates balances on a fixed interval using the client-side
 * accrual calculator, providing smooth visual feedback between ledger events.
 */

import type { Stream, StreamBalances } from '../types/stream.js';
import { getBalances } from './calculator.js';

/** Callback invoked on each tick with a fresh balance snapshot. */
export type TickCallback = (balances: StreamBalances) => void;

/**
 * Periodically recomputes and emits {@link StreamBalances} for a stream.
 *
 * **DISPLAY ONLY** — the ledger is authoritative. Use the ticker to drive
 * progress bars, counters, and balance displays in your UI.
 *
 * @example
 * ```ts
 * const ticker = new BalanceTicker(stream, 500);
 * ticker.onTick((b) => {
 *   progressBar.value = b.percentComplete;
 *   amountLabel.text = b.withdrawable.toFixed(2);
 * });
 * ticker.start();
 *
 * // Later, when the component unmounts:
 * ticker.stop();
 * ```
 */
export class BalanceTicker {
  private readonly stream: Stream;
  private readonly intervalMs: number;
  private readonly callbacks: Set<TickCallback> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a new BalanceTicker.
   *
   * @param stream     - The stream to track. Must remain the same reference;
   *                     if the stream is updated from the ledger, create a new ticker.
   * @param intervalMs - Tick interval in milliseconds. Default: 1000 (1 second).
   */
  constructor(stream: Stream, intervalMs: number = 1000) {
    if (intervalMs <= 0) {
      throw new RangeError('intervalMs must be a positive number');
    }
    this.stream = stream;
    this.intervalMs = intervalMs;
  }

  /**
   * Register a callback to be invoked on every tick.
   * May be called before or after {@link start}.
   *
   * @param callback - Function receiving the latest {@link StreamBalances}.
   * @returns `this` for chaining.
   */
  onTick(callback: TickCallback): this {
    this.callbacks.add(callback);
    return this;
  }

  /**
   * Remove a previously registered tick callback.
   *
   * @param callback - The callback reference to remove.
   * @returns `true` if the callback was found and removed.
   */
  offTick(callback: TickCallback): boolean {
    return this.callbacks.delete(callback);
  }

  /**
   * Start the ticker. Emits an immediate tick, then repeats at `intervalMs`.
   * Calling `start()` when already running is a no-op.
   */
  start(): void {
    if (this.timer !== null) return;

    // Emit immediately so the UI doesn't wait one full interval.
    this.tick();

    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /**
   * Stop the ticker and release the interval timer.
   * Safe to call multiple times or when not running.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Compute the current balances without waiting for the next tick.
   *
   * @param now - Reference time. Defaults to `new Date()`.
   * @returns The latest {@link StreamBalances}.
   */
  getCurrentBalances(now: Date = new Date()): StreamBalances {
    return getBalances(this.stream, now);
  }

  /**
   * Whether the ticker is currently running.
   */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /** Single tick: compute balances and notify all listeners. */
  private tick(): void {
    const balances = getBalances(this.stream, new Date());
    for (const cb of this.callbacks) {
      try {
        cb(balances);
      } catch {
        // Swallow listener errors to prevent one bad callback from
        // breaking the entire tick loop.
      }
    }
  }
}
