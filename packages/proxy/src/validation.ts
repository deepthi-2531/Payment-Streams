/**
 * Request-input guards for the proxy boundary.
 *
 * Validate amounts, party ids, and contract/stream ids BEFORE any Decimal
 * construction or ledger call so bad input fails fast with a 400 instead of
 * producing NaN/Invalid Date accrual or accepting caller-supplied figures.
 */

import Decimal from 'decimal.js';
import { AuthError } from './auth.js';

/** name::fingerprint shape, no comma / CR / LF. */
const PARTY_ID = /^[^,\r\n]+::[0-9a-fA-F]{8,}$/;

function fail(message: string): never {
  throw new AuthError(400, 'invalid_input', message);
}

/** Reject anything containing a CR or LF. */
function hasNewline(value: string): boolean {
  return /[\r\n]/.test(value);
}

/** Parse to a finite Decimal strictly > 0; reject empty/NaN/Infinity/<= 0. */
export function requireAmount(value: unknown, field: string): Decimal {
  if (typeof value !== 'string' && typeof value !== 'number') {
    fail(`Invalid ${field}: expected a positive numeric amount`);
  }
  const raw = String(value).trim();
  if (raw === '') fail(`Invalid ${field}: amount is required`);
  let dec: Decimal;
  try {
    dec = new Decimal(raw);
  } catch {
    fail(`Invalid ${field}: not a valid amount`);
  }
  if (!dec.isFinite() || dec.lessThanOrEqualTo(0)) {
    fail(`Invalid ${field}: amount must be a finite value greater than zero`);
  }
  return dec;
}

/** As requireAmount, but returns undefined when the field is absent. */
export function optionalAmount(value: unknown, field: string): Decimal | undefined {
  if (value === undefined || value === null) return undefined;
  return requireAmount(value, field);
}

/** Non-empty party id matching name::fingerprint with no comma/CR/LF. */
export function requirePartyId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !PARTY_ID.test(value)) {
    fail(`Invalid ${field}: expected a party id of the form name::fingerprint`);
  }
  return value;
}

/** As requirePartyId, but returns undefined when the field is absent. */
export function optionalPartyId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requirePartyId(value, field);
}

/** Non-empty string with no CR/LF (contract id / stream id / reference). */
export function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || hasNewline(value)) {
    fail(`Invalid ${field}: expected a non-empty single-line identifier`);
  }
  return value;
}

/** As requireId, but returns undefined when the field is absent. */
export function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireId(value, field);
}
