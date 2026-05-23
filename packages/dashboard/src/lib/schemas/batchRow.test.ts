/**
 * batchRowSchema — Phase 8 / STR-119 coverage.
 *
 * Locks the CSV-row validation behavior the BatchUpload component relies on.
 */

import { describe, expect, it } from 'vitest';
import { batchRowSchema } from './batchRow.js';

const validRow = {
  recipient: 'bob::1220abcdef',
  amount: '100.00',
  asset: 'USDCx',
  start: '2026-01-01T00:00',
  end: '2026-06-01T00:00',
  vesting: 'Linear',
  cancellable: 'true',
};

describe('batchRowSchema', () => {
  it('accepts a valid row with string cancellable=true', () => {
    const r = batchRowSchema.safeParse(validRow);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cancellable).toBe(true);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['Yes', true],
    ['no', false],
    ['1', true],
    ['0', false],
    ['', false],
  ])('coerces cancellable %s -> %s', (raw, expected) => {
    const r = batchRowSchema.safeParse({ ...validRow, cancellable: raw });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cancellable).toBe(expected);
  });

  it('rejects unparseable cancellable values', () => {
    const r = batchRowSchema.safeParse({
      ...validRow,
      cancellable: 'maybe',
    });
    expect(r.success).toBe(false);
  });

  it('rejects when end <= start', () => {
    const r = batchRowSchema.safeParse({
      ...validRow,
      start: '2026-06-01T00:00',
      end: '2026-01-01T00:00',
    });
    expect(r.success).toBe(false);
  });

  it('rejects recipient without `::`', () => {
    const r = batchRowSchema.safeParse({
      ...validRow,
      recipient: 'bob',
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-positive amount', () => {
    const r = batchRowSchema.safeParse({
      ...validRow,
      amount: '0',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown vesting mode', () => {
    const r = batchRowSchema.safeParse({
      ...validRow,
      vesting: 'Mystery',
    });
    expect(r.success).toBe(false);
  });
});
