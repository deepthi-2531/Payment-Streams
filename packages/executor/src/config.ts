/**
 * Executor service configuration.
 *
 * All values come from environment variables with sensible defaults
 * for local development.
 *
 * @module config
 */

export interface ExecutorConfig {
  /** gRPC ledger host (e.g., "localhost") */
  ledgerHost: string;
  /** gRPC ledger port */
  ledgerPort: number;
  /** TLS enabled */
  ledgerTls: boolean;
  /** JWT token for ledger access */
  ledgerToken: string;
  /** The executor party ID on the ledger */
  executorParty: string;
  /** Poll interval in milliseconds */
  pollIntervalMs: number;
  /** Maximum concurrent executions */
  maxConcurrentExecutions: number;
  /** Log level */
  logLevel: string;
  /** Path for offset persistence file */
  offsetStorePath: string;
  /** Path for the execution idempotency-guard persistence file */
  guardStorePath: string;
}

export function loadConfig(): ExecutorConfig {
  return {
    ledgerHost: env('EXECUTOR_LEDGER_HOST', 'localhost'),
    ledgerPort: parseInt(env('EXECUTOR_LEDGER_PORT', '6865'), 10),
    // The executor is a long-lived daemon carrying delegated-payout
    // authority; its token must not travel in plaintext. TLS defaults ON.
    // Set EXECUTOR_LEDGER_TLS=false only for a loopback/dev participant
    // (the SDK additionally refuses tokens on insecure non-loopback links).
    ledgerTls: env('EXECUTOR_LEDGER_TLS', 'true') !== 'false',
    ledgerToken: env('EXECUTOR_LEDGER_TOKEN', ''),
    executorParty: env('EXECUTOR_PARTY', ''),
    pollIntervalMs: parseInt(env('EXECUTOR_POLL_INTERVAL_MS', '10000'), 10),
    maxConcurrentExecutions: parseInt(env('EXECUTOR_MAX_CONCURRENT', '5'), 10),
    logLevel: env('EXECUTOR_LOG_LEVEL', 'info'),
    offsetStorePath: env('EXECUTOR_OFFSET_PATH', '.executor-offset'),
    guardStorePath: env('EXECUTOR_GUARD_PATH', '.executor-guard'),
  };
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}
