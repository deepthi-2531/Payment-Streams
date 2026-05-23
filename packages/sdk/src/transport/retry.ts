/**
 * @module transport/retry
 *
 * Exponential backoff retry logic for transient gRPC / transport failures.
 * Only retries errors that are known to be transient (UNAVAILABLE,
 * RESOURCE_EXHAUSTED, DEADLINE_EXCEEDED).
 */

import * as grpc from '@grpc/grpc-js';
import { TransportError, LedgerError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('retry');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Options for the retry wrapper. */
export interface RetryOptions {
  /** Maximum number of retry attempts (excluding the initial call). Default: 3. */
  readonly maxRetries?: number;
  /** Base delay in milliseconds before the first retry. Default: 250. */
  readonly baseDelayMs?: number;
  /** Maximum delay in milliseconds (caps exponential growth). Default: 5000. */
  readonly maxDelayMs?: number;
  /** Jitter factor 0–1 added to each delay to decorrelate retries. Default: 0.2. */
  readonly jitterFactor?: number;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitterFactor: 0.2,
};

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

/** gRPC status codes considered transient and safe to retry. */
const RETRYABLE_GRPC_CODES: ReadonlySet<number> = new Set([
  grpc.status.UNAVAILABLE,
  grpc.status.RESOURCE_EXHAUSTED,
  grpc.status.DEADLINE_EXCEEDED,
]);

/**
 * Determine whether an error is transient and eligible for retry.
 *
 * - {@link LedgerError} with a retryable gRPC code.
 * - {@link TransportError} (connection-level failures).
 * - Raw gRPC ServiceError with a retryable code.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof LedgerError && err.grpcCode !== undefined) {
    return RETRYABLE_GRPC_CODES.has(err.grpcCode);
  }
  if (err instanceof TransportError) {
    return true;
  }
  if (err && typeof err === 'object' && 'code' in err) {
    return RETRYABLE_GRPC_CODES.has((err as any).code);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Delay helpers
// ---------------------------------------------------------------------------

/** Compute delay with exponential backoff + jitter. */
function computeDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitter: number,
): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxMs);
  const jitterAmount = capped * jitter * Math.random();
  return capped + jitterAmount;
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute an async function with exponential backoff retries on transient errors.
 *
 * Only transient gRPC failures (UNAVAILABLE, RESOURCE_EXHAUSTED,
 * DEADLINE_EXCEEDED) and transport-level errors are retried. All other
 * errors propagate immediately.
 *
 * @param fn      - The async operation to execute (and potentially retry).
 * @param options - Retry configuration overrides.
 * @returns The result of `fn` on success.
 * @throws The last error encountered if all retries are exhausted.
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => transport.create(templateId, arg, actAs),
 *   { maxRetries: 5, baseDelayMs: 500 },
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isTransient(err)) {
        // Non-transient error — fail immediately.
        throw err;
      }

      if (attempt === opts.maxRetries) {
        // Final attempt exhausted — propagate.
        break;
      }

      const delayMs = computeDelay(
        attempt,
        opts.baseDelayMs,
        opts.maxDelayMs,
        opts.jitterFactor,
      );

      log.warn(
        {
          attempt: attempt + 1,
          maxRetries: opts.maxRetries,
          delayMs: Math.round(delayMs),
          error: lastError instanceof Error ? lastError.message : String(lastError),
        },
        'Transient error — retrying',
      );

      await sleep(delayMs);
    }
  }

  throw lastError;
}
