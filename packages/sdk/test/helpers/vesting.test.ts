import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';

import { buildVestingStream } from '../../src/helpers/vesting.js';
import { createStream } from '../../src/commands/create.js';
import { CreateStreamParamsSchema, validate } from '../../src/utils/validation.js';
import { AssetType, SettlementMode, VestingMode } from '../../src/types/stream.js';

const logger = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  silent: () => undefined,
  child: () => logger,
} as any;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_MICROS = 86_400_000_000;

const instrumentRef = {
  depository: 'AmuletAdmin::1',
  issuer: 'AmuletAdmin::1',
  instrumentId: 'Amulet',
  instrumentVersion: 'v2',
};

const baseOpts = {
  streamId: 'vest-alice-1',
  sender: 'treasury',
  recipient: 'alice',
  totalAmount: '48000',
  startTime: new Date('2026-07-01T00:00:00Z'),
  instrumentRef,
  escrowOperator: 'escrow-operator',
  fundingReference: 'allocation-funding-1',
};

describe('buildVestingStream', () => {
  it('produces params that pass createStream validation', () => {
    const params = buildVestingStream(baseOpts);

    expect(() => validate(CreateStreamParamsSchema, params)).not.toThrow();
    expect(params.settlementMode).toBe(SettlementMode.TokenStandardCustody);
    expect(params.assetType).toBe(AssetType.GlobalCip56);
    expect(params.fundingReference).toBe('allocation-funding-1');
    expect(params.senderAccount).toEqual({ owner: 'treasury', id: '' });
    expect(params.recipientAccount).toEqual({ owner: 'alice', id: '' });
    expect(params.cancellable).toBe(false);
  });

  it('is accepted end-to-end by createStream', async () => {
    const transport = {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ contractId: '#admin-001', result: {} }),
    } as any;

    const params = buildVestingStream(baseOpts);
    const result = await createStream(transport, params, ['treasury'], logger);

    expect(result).toEqual({ requestContractId: '#admin-001', streamId: 'vest-alice-1' });
    expect(transport.create).toHaveBeenCalledTimes(1);
  });

  it('computes CliffLinear math for a 90-day cliff + 12-month linear vest', () => {
    const params = buildVestingStream({ ...baseOpts, durationDays: 365, cliffDays: 90 });

    expect(params.endTime).toEqual(new Date(baseOpts.startTime.getTime() + 365 * DAY_MS));
    expect(params.vestingMode).toEqual({
      mode: VestingMode.CliffLinear,
      cliffTime: new Date(baseOpts.startTime.getTime() + 90 * DAY_MS),
    });
    expect(params.totalDeposited).toEqual(new Decimal('48000'));
  });

  it('computes Stepped intervals in RelTime microseconds', () => {
    const params = buildVestingStream({
      ...baseOpts,
      style: 'stepped',
      durationDays: 360,
      steps: 4,
    });

    expect(params.vestingMode).toEqual({
      mode: VestingMode.Stepped,
      stepInterval: 90 * DAY_MICROS,
      amountPerStep: new Decimal('12000'),
    });
    expect(() => validate(CreateStreamParamsSchema, params)).not.toThrow();
  });

  it('builds cliffless linear vesting on request', () => {
    const params = buildVestingStream({ ...baseOpts, style: 'linear' });

    expect(params.vestingMode).toEqual({ mode: VestingMode.Linear });
    expect(() => validate(CreateStreamParamsSchema, params)).not.toThrow();
  });

  it('rejects non-positive amounts', () => {
    expect(() => buildVestingStream({ ...baseOpts, totalAmount: 0 })).toThrow('must be > 0');
    expect(() => buildVestingStream({ ...baseOpts, totalAmount: '-100' })).toThrow('must be > 0');
  });

  it('rejects a non-positive duration (end before start)', () => {
    expect(() => buildVestingStream({ ...baseOpts, durationDays: 0 })).toThrow('durationDays');
    expect(() => buildVestingStream({ ...baseOpts, durationDays: -30 })).toThrow('durationDays');
  });

  it('rejects a cliff at or beyond the total duration', () => {
    expect(() => buildVestingStream({ ...baseOpts, durationDays: 90, cliffDays: 90 })).toThrow(
      'shorter than total duration',
    );
    expect(() => buildVestingStream({ ...baseOpts, cliffDays: 0 })).toThrow('cliffDays > 0');
  });

  it('rejects stepped vesting without at least one step', () => {
    expect(() => buildVestingStream({ ...baseOpts, style: 'stepped', steps: 0 })).toThrow(
      'at least 1 step',
    );
  });
});
