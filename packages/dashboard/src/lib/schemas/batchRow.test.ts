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
  instrumentAdmin: 'amulet::1220admin',
  fundingReference: 'allocation-001',
  senderAccount: '{"owner":"alice::1220sender","id":"default"}',
  recipientAccount: '{"owner":"bob::1220abcdef","id":"default"}',
  escrowOperator: 'operator::1220escrow',
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

  it('rejects invalid account JSON', () => {
    const r = batchRowSchema.safeParse({
      ...validRow,
      senderAccount: 'not-json',
    });
    expect(r.success).toBe(false);
  });

  // Per-variant required columns. The earlier batch path silently
  // defaulted stepInterval / termDuration / cliffTime when CSV omitted
  // them, shipping wrong vesting curves on-ledger. The schema now
  // requires the right column per variant.
  describe('per-variant required fields', () => {
    it('accepts a CliffLinear row with valid cliffTime', () => {
      const r = batchRowSchema.safeParse({
        ...validRow,
        vesting: 'CliffLinear',
        cliffTime: '2026-03-01T00:00',
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.cliffTime).toBe('2026-03-01T00:00');
    });

    it('rejects a CliffLinear row missing cliffTime', () => {
      const r = batchRowSchema.safeParse({ ...validRow, vesting: 'CliffLinear' });
      expect(r.success).toBe(false);
    });

    it('rejects a CliffLinear row where cliffTime is outside [start, end)', () => {
      const r = batchRowSchema.safeParse({
        ...validRow,
        vesting: 'CliffLinear',
        cliffTime: '2025-12-31T00:00', // before start
      });
      expect(r.success).toBe(false);
    });

    it('accepts a Stepped row with stepInterval + amountPerStep', () => {
      const r = batchRowSchema.safeParse({
        ...validRow,
        vesting: 'Stepped',
        stepInterval: '86400000000',
        amountPerStep: '1',
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.stepInterval).toBe(86_400_000_000);
        expect(r.data.amountPerStep).toBe('1');
      }
    });

    it('rejects a Stepped row missing stepInterval', () => {
      const r = batchRowSchema.safeParse({
        ...validRow,
        vesting: 'Stepped',
        amountPerStep: '1',
      });
      expect(r.success).toBe(false);
    });

    it('rejects a Stepped row missing amountPerStep', () => {
      const r = batchRowSchema.safeParse({
        ...validRow,
        vesting: 'Stepped',
        stepInterval: '86400000000',
      });
      expect(r.success).toBe(false);
    });

    it('accepts a RenewableTerm row with termDuration', () => {
      const r = batchRowSchema.safeParse({
        ...validRow,
        vesting: 'RenewableTerm',
        termDuration: '2592000000000',
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.termDuration).toBe(2_592_000_000_000);
    });

    it('rejects a RenewableTerm row missing termDuration', () => {
      const r = batchRowSchema.safeParse({
        ...validRow,
        vesting: 'RenewableTerm',
      });
      expect(r.success).toBe(false);
    });

    it('accepts a Linear row that leaves the per-variant columns empty', () => {
      const r = batchRowSchema.safeParse({
        ...validRow,
        cliffTime: '',
        stepInterval: '',
        amountPerStep: '',
        termDuration: '',
      });
      expect(r.success).toBe(true);
    });
  });
});
