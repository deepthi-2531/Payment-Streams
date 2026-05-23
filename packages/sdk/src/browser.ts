/**
 * @canton-streams/sdk/browser
 *
 * Browser-safe exports for the Canton Streams SDK.
 *
 * This entry point excludes all Node.js dependencies (@grpc/grpc-js,
 * node:path, node:url, pino) and is safe to import from browser bundles
 * (Vite, webpack, etc.).
 *
 * Use this in the dashboard or any browser application. For ledger
 * operations from the browser, use the REST proxy server — the gRPC
 * transport is Node-only.
 *
 * @license Apache-2.0
 */

// Types (erased at compile time — no runtime cost)
export type { ClientConfig } from './types/config.js';
export type {
  Stream,
  StreamConfig,
  StreamState,
  StreamBalances,
  LedgerRecord,
  LedgerRecordValue,
  HoldingFunding,
  InstrumentRef,
  EscrowOperatorRef,
  FundingRef,
  EscrowRef,
  VestingModeConfig,
  CreateStreamParams,
  CreateBatchParams,
  FinalizeEscrowParams,
  TokenStandardWithdrawParams,
  TokenStandardCancelParams,
  WithdrawResult,
  CancelResult,
  RenewParams,
  StreamFilter,
  PendingStreamRequest,
  PendingStreamRequestFilter,
  StreamEvent,
  StreamEventSource,
  StreamUpdate,
} from './types/stream.js';
export type { RetryOptions } from './transport/retry.js';

// Runtime value exports (all browser-safe — no Node.js deps)
export { VestingMode, StreamStatus, AssetType, SettlementMode } from './types/stream.js';

// Accrual calculator — pure math, display-only (browser-safe)
export {
  linearAccrual,
  cliffLinearAccrual,
  steppedAccrual,
  getBalances,
} from './accrual/calculator.js';

// Balance ticker — setInterval-based, browser-safe
export { BalanceTicker } from './accrual/ticker.js';

// JSON API transport — browser-safe HTTP transport
export { JsonApiTransport, JsonApiError } from './transport/json-api.js';
export type { JsonApiConfig } from './transport/json-api.js';

// Error hierarchy — browser-safe
export {
  CantonStreamsError,
  TransportError,
  ValidationError,
  LedgerError,
  InvariantViolationError,
} from './utils/errors.js';

// Validation — zod schemas, browser-safe
export {
  validate,
  CreateStreamParamsSchema,
  RenewParamsSchema,
  StreamFilterSchema,
} from './utils/validation.js';
