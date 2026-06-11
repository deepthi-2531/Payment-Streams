import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../../src/transport/retry.js';
import { TransportError, LedgerError, ValidationError } from '../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// We need to mock @grpc/grpc-js status codes since the retry module uses them.
// The actual grpc status enum values:
//   UNAVAILABLE = 14, RESOURCE_EXHAUSTED = 8, DEADLINE_EXCEEDED = 4
// ---------------------------------------------------------------------------

// Use fake timers so sleep() resolves instantly.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Helper to advance all pending timers (for sleep in retry loops). */
async function flushTimers() {
  await vi.runAllTimersAsync();
}

// ===========================================================================
// withRetry
// ===========================================================================

describe('withRetry', () => {
  it('succeeds on first try', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on TransportError and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TransportError('connection lost'))
      .mockRejectedValueOnce(new TransportError('connection lost again'))
      .mockResolvedValue('recovered');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 });

    // Flush timers for each retry sleep
    await flushTimers();

    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on LedgerError with UNAVAILABLE gRPC code (14)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new LedgerError('unavailable', 14, 'UNAVAILABLE'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 });
    await flushTimers();

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on LedgerError with RESOURCE_EXHAUSTED gRPC code (8)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new LedgerError('exhausted', 8, 'RESOURCE_EXHAUSTED'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 });
    await flushTimers();

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on LedgerError with DEADLINE_EXCEEDED gRPC code (4)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new LedgerError('deadline', 4, 'DEADLINE_EXCEEDED'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 });
    await flushTimers();

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on raw error with retryable gRPC code property', async () => {
    const rawError = Object.assign(new Error('raw grpc'), { code: 14 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rawError)
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 });
    await flushTimers();

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('fails immediately on non-transient ValidationError', async () => {
    const fn = vi.fn().mockRejectedValue(new ValidationError('bad input'));

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow(ValidationError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fails immediately on LedgerError with non-retryable code', async () => {
    // NOT_FOUND = 5, which is not in the retryable set
    const fn = vi.fn().mockRejectedValue(new LedgerError('not found', 5, 'NOT_FOUND'));

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow(LedgerError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fails immediately on generic Error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('random'));

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow('random');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries and throws last transient error', async () => {
    const fn = vi.fn().mockRejectedValue(new TransportError('persistent failure'));

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 });
    // Attach rejection handler immediately to avoid unhandled rejection warnings
    const assertion = expect(promise).rejects.toThrow(TransportError);
    await flushTimers();
    await assertion;
    // initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects maxRetries option', async () => {
    const fn = vi.fn().mockRejectedValue(new TransportError('fail'));

    const promise = withRetry(fn, { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 });
    const assertion = expect(promise).rejects.toThrow(TransportError);
    await flushTimers();
    await assertion;
    // initial + 1 retry = 2 calls
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects maxRetries: 0 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new TransportError('fail'));

    const promise = withRetry(fn, { maxRetries: 0 });
    const assertion = expect(promise).rejects.toThrow(TransportError);
    await flushTimers();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry transient errors when idempotent: false', async () => {
    const fn = vi.fn().mockRejectedValue(new TransportError('submission failed'));

    await expect(
      withRetry(fn, { maxRetries: 3, idempotent: false }),
    ).rejects.toThrow(TransportError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
