import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';

import { buildIncentiveStream } from '../../src/helpers/lpIncentives.js';
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
  streamId: 'lp-campaign-1',
  sender: 'treasury',
  recipient: 'lp-wallet',
  rewardAmount: '9000',
  startTime: new Date('2026-08-01T00:00:00Z'),
  instrumentRef,
  escrowOperator: 'escrow-operator',
  fundingReference: 'campaign-funding-1',
};

describe('buildIncentiveStream', () => {
  it('produces Linear campaign params that pass createStream validation', () => {
    const params = buildIncentiveStream(baseOpts);

    expect(() => validate(CreateStreamParamsSchema, params)).not.toThrow();
    expect(params.vestingMode).toEqual({ mode: VestingMode.Linear });
    expect(params.settlementMode).toBe(SettlementMode.TokenStandardCustody);
    expect(params.assetType).toBe(AssetType.GlobalCip56);
    expect(params.senderAccount).toEqual({ owner: 'treasury', id: '' });
    expect(params.recipientAccount).toEqual({ owner: 'lp-wallet', id: '' });
    expect(params.cancellable).toBe(false);
  });

  it('is accepted end-to-end by createStream', async () => {
    const transport = {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ contractId: '#admin-lp-001', result: {} }),
    } as any;

    const params = buildIncentiveStream(baseOpts);
    const result = await createStream(transport, params, ['treasury'], logger);

    expect(result).toEqual({ requestContractId: '#admin-lp-001', streamId: 'lp-campaign-1' });
  });

  it('builds a renewable 30-day term with RelTime microseconds', () => {
    const params = buildIncentiveStream({ ...baseOpts, renewable: true, durationDays: 30 });

    expect(params.vestingMode).toEqual({
      mode: VestingMode.RenewableTerm,
      termDuration: 30 * DAY_MICROS,
    });
    expect(params.endTime).toEqual(new Date(baseOpts.startTime.getTime() + 30 * DAY_MS));
    expect(params.totalDeposited).toEqual(new Decimal('9000'));
    expect(() => validate(CreateStreamParamsSchema, params)).not.toThrow();
  });

  it('rejects non-positive reward amounts', () => {
    expect(() => buildIncentiveStream({ ...baseOpts, rewardAmount: 0 })).toThrow('must be > 0');
    expect(() => buildIncentiveStream({ ...baseOpts, rewardAmount: '-1' })).toThrow('must be > 0');
  });

  it('rejects a non-positive duration (end before start)', () => {
    expect(() => buildIncentiveStream({ ...baseOpts, durationDays: 0 })).toThrow('durationDays');
    expect(() => buildIncentiveStream({ ...baseOpts, durationDays: -7 })).toThrow('durationDays');
  });
});
