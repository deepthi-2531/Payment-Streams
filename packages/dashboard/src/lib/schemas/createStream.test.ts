/**
 * createStreamSchema — Phase 8 / STR-119 coverage.
 *
 * Locks the key behaviors the wizard relies on:
 *   • happy-path Linear / TokenStandardCustody
 *   • rejects legacy settlement modes
 *   • endTime > startTime cross-field refinement
 *   • CliffLinear: cliffTime must satisfy start ≤ cliff < end
 *   • Stepped requires positive interval + decimal amount
 */

import { describe, expect, it } from 'vitest';
import { AssetType, SettlementMode, VestingMode } from '@canton-streams/sdk/browser';
import { createStreamSchema } from './createStream.js';

const validBase = {
  recipient: 'bob::1220abcdef',
  totalDeposited: '1000.00',
  assetType: AssetType.GlobalCip56,
  instrumentAdmin: 'AmuletAdmin::1220admin',
  instrumentId: 'Amulet',
  startTime: '2026-01-01T00:00',
  endTime: '2026-12-31T00:00',
  cancellable: true,
  vestingMode: VestingMode.Linear,
  settlementMode: SettlementMode.TokenStandardCustody,
  fundingReference: 'source-allocation',
  escrowOperator: 'EscrowOperator::1220de1',
  senderAccount: '{"a":1}',
  recipientAccount: '{"b":1}',
};

describe('createStreamSchema', () => {
  it('accepts a valid Linear / TokenStandardCustody payload', () => {
    const r = createStreamSchema.safeParse(validBase);
    expect(r.success).toBe(true);
  });

  it('rejects legacy settlement modes', () => {
    const r = createStreamSchema.safeParse({
      ...validBase,
      settlementMode: SettlementMode.UtilityHoldingCustody,
      holdingCid: 'holding-cid',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(' ');
      expect(msg).toMatch(/Invalid input/);
    }
  });

  it('rejects when endTime <= startTime', () => {
    const r = createStreamSchema.safeParse({
      ...validBase,
      startTime: '2026-12-31T00:00',
      endTime: '2026-01-01T00:00',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /endTime/.test(i.message))).toBe(true);
    }
  });

  it('rejects CliffLinear when cliffTime is before startTime', () => {
    const r = createStreamSchema.safeParse({
      ...validBase,
      vestingMode: VestingMode.CliffLinear,
      cliffTime: '2025-12-01T00:00',
    });
    expect(r.success).toBe(false);
  });

  it('accepts CliffLinear when start <= cliff < end', () => {
    const r = createStreamSchema.safeParse({
      ...validBase,
      vestingMode: VestingMode.CliffLinear,
      cliffTime: '2026-06-01T00:00',
    });
    expect(r.success).toBe(true);
  });

  it('rejects Stepped with non-positive stepInterval', () => {
    const r = createStreamSchema.safeParse({
      ...validBase,
      vestingMode: VestingMode.Stepped,
      stepInterval: 0,
      amountPerStep: '10',
    });
    expect(r.success).toBe(false);
  });

  it('rejects party id without `::`', () => {
    const r = createStreamSchema.safeParse({
      ...validBase,
      recipient: 'bob-no-namespace',
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative totalDeposited', () => {
    const r = createStreamSchema.safeParse({
      ...validBase,
      totalDeposited: '-5.00',
    });
    expect(r.success).toBe(false);
  });

  it('rejects scientific-notation amounts', () => {
    const r = createStreamSchema.safeParse({
      ...validBase,
      totalDeposited: '1e3',
    });
    expect(r.success).toBe(false);
  });
});
