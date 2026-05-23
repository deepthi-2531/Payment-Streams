import { describe, it, expect } from 'vitest';
import {
  CantonStreamsError,
  TransportError,
  ValidationError,
  LedgerError,
  InvariantViolationError,
} from '../../src/utils/errors.js';

// ===========================================================================
// CantonStreamsError (base)
// ===========================================================================

describe('CantonStreamsError', () => {
  it('has the correct name and code', () => {
    const err = new CantonStreamsError('TEST_CODE', 'test message');
    expect(err.name).toBe('CantonStreamsError');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test message');
  });

  it('is an instance of Error', () => {
    const err = new CantonStreamsError('CODE', 'msg');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CantonStreamsError);
  });

  it('supports cause chaining', () => {
    const cause = new Error('root cause');
    const err = new CantonStreamsError('CODE', 'wrapper', { cause });
    expect(err.cause).toBe(cause);
  });
});

// ===========================================================================
// TransportError
// ===========================================================================

describe('TransportError', () => {
  it('has code TRANSPORT_ERROR', () => {
    const err = new TransportError('connection failed');
    expect(err.code).toBe('TRANSPORT_ERROR');
    expect(err.name).toBe('TransportError');
  });

  it('is instanceof CantonStreamsError and Error', () => {
    const err = new TransportError('fail');
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toBeInstanceOf(CantonStreamsError);
    expect(err).toBeInstanceOf(Error);
  });

  it('stores statusCode', () => {
    const err = new TransportError('unavailable', 503);
    expect(err.statusCode).toBe(503);
  });

  it('statusCode is undefined when not provided', () => {
    const err = new TransportError('fail');
    expect(err.statusCode).toBeUndefined();
  });

  it('supports cause chaining', () => {
    const cause = new Error('socket timeout');
    const err = new TransportError('fail', 503, { cause });
    expect(err.cause).toBe(cause);
  });
});

// ===========================================================================
// ValidationError
// ===========================================================================

describe('ValidationError', () => {
  it('has code VALIDATION_ERROR', () => {
    const err = new ValidationError('bad input');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.name).toBe('ValidationError');
  });

  it('is instanceof CantonStreamsError and Error', () => {
    const err = new ValidationError('bad');
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toBeInstanceOf(CantonStreamsError);
    expect(err).toBeInstanceOf(Error);
  });

  it('stores field and details', () => {
    const err = new ValidationError('bad amount', 'amount', 'Must be positive');
    expect(err.field).toBe('amount');
    expect(err.details).toBe('Must be positive');
  });

  it('field and details are undefined when not provided', () => {
    const err = new ValidationError('bad');
    expect(err.field).toBeUndefined();
    expect(err.details).toBeUndefined();
  });

  it('supports cause chaining', () => {
    const cause = new Error('zod parse');
    const err = new ValidationError('bad', 'f', 'd', { cause });
    expect(err.cause).toBe(cause);
  });
});

// ===========================================================================
// LedgerError
// ===========================================================================

describe('LedgerError', () => {
  it('has code LEDGER_ERROR', () => {
    const err = new LedgerError('ledger down');
    expect(err.code).toBe('LEDGER_ERROR');
    expect(err.name).toBe('LedgerError');
  });

  it('is instanceof CantonStreamsError and Error', () => {
    const err = new LedgerError('fail');
    expect(err).toBeInstanceOf(LedgerError);
    expect(err).toBeInstanceOf(CantonStreamsError);
    expect(err).toBeInstanceOf(Error);
  });

  it('stores grpcCode and grpcMessage', () => {
    const err = new LedgerError('not found', 5, 'NOT_FOUND');
    expect(err.grpcCode).toBe(5);
    expect(err.grpcMessage).toBe('NOT_FOUND');
  });

  it('grpcCode and grpcMessage are undefined when not provided', () => {
    const err = new LedgerError('fail');
    expect(err.grpcCode).toBeUndefined();
    expect(err.grpcMessage).toBeUndefined();
  });

  it('supports cause chaining', () => {
    const cause = new Error('grpc stream');
    const err = new LedgerError('fail', 14, 'UNAVAILABLE', { cause });
    expect(err.cause).toBe(cause);
  });
});

// ===========================================================================
// InvariantViolationError
// ===========================================================================

describe('InvariantViolationError', () => {
  it('has code INVARIANT_VIOLATION', () => {
    const err = new InvariantViolationError('impossible state');
    expect(err.code).toBe('INVARIANT_VIOLATION');
    expect(err.name).toBe('InvariantViolationError');
  });

  it('is instanceof CantonStreamsError and Error', () => {
    const err = new InvariantViolationError('bug');
    expect(err).toBeInstanceOf(InvariantViolationError);
    expect(err).toBeInstanceOf(CantonStreamsError);
    expect(err).toBeInstanceOf(Error);
  });

  it('supports cause chaining', () => {
    const cause = new Error('root');
    const err = new InvariantViolationError('bug', { cause });
    expect(err.cause).toBe(cause);
  });
});

// ===========================================================================
// Cross-type instanceof checks
// ===========================================================================

describe('instanceof isolation', () => {
  it('TransportError is not instanceof ValidationError', () => {
    const err = new TransportError('fail');
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(LedgerError);
    expect(err).not.toBeInstanceOf(InvariantViolationError);
  });

  it('ValidationError is not instanceof TransportError', () => {
    const err = new ValidationError('bad');
    expect(err).not.toBeInstanceOf(TransportError);
    expect(err).not.toBeInstanceOf(LedgerError);
    expect(err).not.toBeInstanceOf(InvariantViolationError);
  });

  it('LedgerError is not instanceof TransportError', () => {
    const err = new LedgerError('fail');
    expect(err).not.toBeInstanceOf(TransportError);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(InvariantViolationError);
  });
});
