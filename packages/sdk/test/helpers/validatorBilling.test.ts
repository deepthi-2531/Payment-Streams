import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';

import {
  buildRecurringBillingStream,
  buildUsageBillingFlow,
} from '../../src/helpers/validatorBilling.js';
import { createStream } from '../../src/commands/create.js';
import { CreateStreamParamsSchema, validate } from '../../src/utils/validation.js';
import { SettlementMode, VestingMode } from '../../src/types/stream.js';

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

const recurringOpts = {
  streamId: 'billing-acme-1',
  payer: 'acme-customer',
  payee: 'gateway-provider',
  amountPerPeriod: '100',
  startTime: new Date('2026-09-01T00:00:00Z'),
  instrumentRef,
  escrowOperator: 'escrow-operator',
  fundingReference: 'billing-funding-1',
};

describe('buildRecurringBillingStream', () => {
  it('produces RenewableTerm params that pass createStream validation', () => {
    const params = buildRecurringBillingStream(recurringOpts);

    expect(() => validate(CreateStreamParamsSchema, params)).not.toThrow();
    expect(params.settlementMode).toBe(SettlementMode.TokenStandardCustody);
    expect(params.sender).toBe('acme-customer');
    expect(params.recipient).toBe('gateway-provider');
    expect(params.cancellable).toBe(true);
    expect(params.senderAccount).toEqual({ owner: 'acme-customer', id: '' });
    expect(params.recipientAccount).toEqual({ owner: 'gateway-provider', id: '' });
  });

  it('is accepted end-to-end by createStream', async () => {
    const transport = {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ contractId: '#admin-bill-001', result: {} }),
    } as any;

    const params = buildRecurringBillingStream(recurringOpts);
    const result = await createStream(transport, params, ['acme-customer'], logger);

    expect(result).toEqual({ requestContractId: '#admin-bill-001', streamId: 'billing-acme-1' });
  });

  it('computes 30-day term math across pre-paid periods', () => {
    const params = buildRecurringBillingStream({
      ...recurringOpts,
      periodDays: 30,
      totalPeriods: 3,
    });

    expect(params.totalDeposited).toEqual(new Decimal('300'));
    expect(params.endTime).toEqual(new Date(recurringOpts.startTime.getTime() + 90 * DAY_MS));
    expect(params.vestingMode).toEqual({
      mode: VestingMode.RenewableTerm,
      termDuration: 30 * DAY_MICROS,
    });
  });

  it('rejects non-positive amounts and invalid periods', () => {
    expect(() => buildRecurringBillingStream({ ...recurringOpts, amountPerPeriod: 0 })).toThrow(
      'must be > 0',
    );
    expect(() => buildRecurringBillingStream({ ...recurringOpts, amountPerPeriod: '-5' })).toThrow(
      'must be > 0',
    );
    expect(() => buildRecurringBillingStream({ ...recurringOpts, periodDays: 0 })).toThrow(
      'periodDays',
    );
    expect(() => buildRecurringBillingStream({ ...recurringOpts, totalPeriods: 0 })).toThrow(
      'at least 1',
    );
  });
});

const flowOpts = {
  streamId: 'usage-acme-1',
  payer: 'acme-customer',
  payee: 'gateway-provider',
  pricePerUnitPerSecond: '0.5',
  startTime: new Date('2026-09-01T00:00:00Z'),
  initialFundedAmount: '1000',
  initialFundingReference: 'flow-funding-1',
  instrumentRef,
  escrowOperator: 'escrow-operator',
};

describe('buildUsageBillingFlow', () => {
  it('mirrors the StreamFlow template create fields', () => {
    const params = buildUsageBillingFlow(flowOpts);

    // Field names match CantonStreams.Stream.StreamFlow create arguments.
    expect(params).toEqual({
      streamId: 'usage-acme-1',
      sender: 'acme-customer',
      recipient: 'gateway-provider',
      escrowOperator: 'escrow-operator',
      instrumentRef,
      flowRate: new Decimal('0.0000005'),
      startTime: flowOpts.startTime,
      fundedAmount: new Decimal('1000'),
      lastSettlementReference: 'flow-funding-1',
      observers: [],
    });
  });

  it('converts per-second pricing to tokens per microsecond', () => {
    const params = buildUsageBillingFlow({ ...flowOpts, pricePerUnitPerSecond: '1' });

    expect(params.flowRate).toEqual(new Decimal(1).div(1_000_000));
    expect(params.flowRate.gt(0)).toBe(true); // template ensure: flowRate > 0
  });

  it('rejects non-positive flow rates and negative funding', () => {
    expect(() => buildUsageBillingFlow({ ...flowOpts, pricePerUnitPerSecond: 0 })).toThrow(
      'must be > 0',
    );
    expect(() => buildUsageBillingFlow({ ...flowOpts, pricePerUnitPerSecond: '-0.1' })).toThrow(
      'must be > 0',
    );
    expect(() => buildUsageBillingFlow({ ...flowOpts, initialFundedAmount: '-1' })).toThrow(
      'must be >= 0',
    );
  });
});
