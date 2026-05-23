/**
 * @module utils/logger
 *
 * Structured logging via Pino for the Canton Streams SDK.
 * All SDK internals use this logger; consumers can override the level.
 */

import pino, { type Logger, type Level } from 'pino';

/** Default log level when none is explicitly configured. */
const DEFAULT_LEVEL: Level = 'info';

/**
 * Create a namespaced child logger for an SDK module.
 *
 * @param name  - Module name (e.g. "transport", "accrual").
 * @param level - Minimum log level. Defaults to "info".
 * @returns A Pino Logger instance.
 */
export function createLogger(name: string, level?: Level): Logger {
  return pino({
    name: `canton-streams:${name}`,
    level: level ?? DEFAULT_LEVEL,
    // Deterministic timestamp format for structured log aggregation.
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Set the log level for an existing logger at runtime.
 *
 * @param logger - The Pino logger to reconfigure.
 * @param level  - The new minimum log level.
 */
export function setLogLevel(logger: Logger, level: Level): void {
  logger.level = level;
}
