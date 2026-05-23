/**
 * @module utils/errors
 *
 * Structured error hierarchy for Canton Payment Streams SDK.
 * Every error carries a machine-readable `code` for programmatic handling.
 */

/**
 * Base error for all Canton Streams SDK errors.
 * Extend this class to create domain-specific error types.
 */
export class CantonStreamsError extends Error {
  /** Machine-readable error code (e.g. "TRANSPORT_UNAVAILABLE"). */
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CantonStreamsError';
    this.code = code;
    // Restore prototype chain (required for correct `instanceof` with TS targets < ES2022).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error originating from the network / transport layer.
 * Typically wraps gRPC connectivity failures.
 */
export class TransportError extends CantonStreamsError {
  /** HTTP-style status code, if available. */
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number, options?: ErrorOptions) {
    super('TRANSPORT_ERROR', message, options);
    this.name = 'TransportError';
    this.statusCode = statusCode;
  }
}

/**
 * Error raised when client-side input validation fails.
 * Thrown *before* any ledger round-trip.
 */
export class ValidationError extends CantonStreamsError {
  /** Name of the field that failed validation, if applicable. */
  readonly field?: string;
  /** Human-readable explanation of the validation rule that was violated. */
  readonly details?: string;

  constructor(message: string, field?: string, details?: string, options?: ErrorOptions) {
    super('VALIDATION_ERROR', message, options);
    this.name = 'ValidationError';
    this.field = field;
    this.details = details;
  }
}

/**
 * Error returned by the Canton Ledger API (gRPC).
 * Preserves the original gRPC status code and message for debugging.
 */
export class LedgerError extends CantonStreamsError {
  /** gRPC numeric status code (see grpc.status). */
  readonly grpcCode?: number;
  /** Original error message from the Ledger API. */
  readonly grpcMessage?: string;

  constructor(message: string, grpcCode?: number, grpcMessage?: string, options?: ErrorOptions) {
    super('LEDGER_ERROR', message, options);
    this.name = 'LedgerError';
    this.grpcCode = grpcCode;
    this.grpcMessage = grpcMessage;
  }
}

/**
 * Error indicating a violated internal invariant.
 * If this is thrown, there is a bug in the SDK itself.
 */
export class InvariantViolationError extends CantonStreamsError {
  constructor(message: string, options?: ErrorOptions) {
    super('INVARIANT_VIOLATION', message, options);
    this.name = 'InvariantViolationError';
  }
}
