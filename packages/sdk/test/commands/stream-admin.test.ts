/**
 * Unit tests for commands/stream-admin.ts — V2-only StreamAdmin
 * orchestration helpers (STR-86).
 *
 * Covers:
 *   - buildStreamAdminCreate payload shape (template id, signatories,
 *     vesting-mode encoding, initial state defaults)
 *   - buildSyncIteration argument shape + transport dispatch
 *   - buildMarkCancelled argument shape + transport dispatch
 *   - buildMarkCompleted argument shape + transport dispatch
 */

import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';

import {
  buildStreamAdminCreate,
  buildSyncIteration,
  buildMarkCancelled,
  buildMarkCompleted,
  type CreateStreamAdminParams,
  type VestingMode,
} from '../../src/commands/stream-admin.js';
import { TEMPLATE_STREAM_ADMIN } from '../../src/templates.js';
import type { Transport } from '../../src/transport/base.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => silentLogger),
} as never;

function mockTransport(returnContractId = 'new-admin-cid'): Transport {
  return {
    create: vi.fn(),
    exercise: vi.fn(() => Promise.resolve({ contractId: returnContractId } as never)),
    query: vi.fn(),
    queryByContractId: vi.fn(),
  } as unknown as Transport;
}

function commonCreateParams(
  overrides: Partial<CreateStreamAdminParams> = {},
): CreateStreamAdminParams {
  return {
    streamId: 'stream-001',
    sender: 'alice',
    recipient: 'bob',
    operator: 'carol',
    instrumentRef: {
      depository: 'admin-party',
      issuer: 'admin-party',
      instrumentId: 'CC',
      instrumentVersion: '1.0',
    },
    totalDeposited: new Decimal('1000'),
    vestingMode: { tag: 'Linear' },
    startTime: new Date('2026-01-01T00:00:00Z'),
    endTime: new Date('2026-07-01T00:00:00Z'),
    cancellable: true,
    observers: [],
    ...overrides,
  };
}

describe('buildStreamAdminCreate', () => {
  it('emits the correct template id', () => {
    const payload = buildStreamAdminCreate(commonCreateParams());
    expect(payload.templateId).toEqual(TEMPLATE_STREAM_ADMIN);
  });

  it('includes the sender as the create signatory', () => {
    const payload = buildStreamAdminCreate(commonCreateParams());
    expect(payload.signatories).toEqual(['alice']);
  });

  it('initializes mutable state correctly', () => {
    const payload = buildStreamAdminCreate(commonCreateParams());
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.totalWithdrawn).toEqual({ numeric: '0.0000000000' });
    expect(arg.numIterations).toEqual({ int64: '0' });
    expect(arg.status).toEqual({ enum: { enum_constructor: 'Active' } });
    expect(arg.currentAllocationCid).toEqual({ optional: null });
    expect(arg.originalAllocationId).toEqual({ optional: null });
  });

  it('encodes Linear vesting mode', () => {
    const payload = buildStreamAdminCreate(commonCreateParams());
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.vestingMode).toEqual({
      variant: { variant_constructor: 'Linear', value: { unit: {} } },
    });
  });

  it('encodes CliffLinear vesting mode', () => {
    const cliffAt = new Date('2026-04-01T00:00:00Z');
    const vm: VestingMode = { tag: 'CliffLinear', cliffTime: cliffAt };
    const payload = buildStreamAdminCreate(commonCreateParams({ vestingMode: vm }));
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.vestingMode).toEqual({
      variant: {
        variant_constructor: 'CliffLinear',
        value: { cliffTime: { timestamp: (BigInt(cliffAt.getTime()) * 1000n).toString() } },
      },
    });
  });

  it('encodes Stepped vesting mode', () => {
    const vm: VestingMode = {
      tag: 'Stepped',
      stepIntervalMicros: 86400000000n, // 1 day
      amountPerStep: new Decimal('10'),
    };
    const payload = buildStreamAdminCreate(commonCreateParams({ vestingMode: vm }));
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.vestingMode).toEqual({
      variant: {
        variant_constructor: 'Stepped',
        value: {
          stepInterval: { microseconds: '86400000000' },
          amountPerStep: { numeric: '10.0000000000' },
        },
      },
    });
  });

  it('encodes RenewableTerm vesting mode', () => {
    const vm: VestingMode = {
      tag: 'RenewableTerm',
      termDurationMicros: 2592000000000n, // 30 days
    };
    const payload = buildStreamAdminCreate(commonCreateParams({ vestingMode: vm }));
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.vestingMode).toEqual({
      variant: {
        variant_constructor: 'RenewableTerm',
        value: { termDuration: { microseconds: '2592000000000' } },
      },
    });
  });

  it('passes observers through as parties', () => {
    const payload = buildStreamAdminCreate(
      commonCreateParams({ observers: ['observer1', 'observer2'] }),
    );
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.observers).toEqual([{ party: 'observer1' }, { party: 'observer2' }]);
  });

  it('serializes totalDeposited with 10 decimal places', () => {
    const payload = buildStreamAdminCreate(
      commonCreateParams({ totalDeposited: new Decimal('1234.567') }),
    );
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.totalDeposited).toEqual({ numeric: '1234.5670000000' });
  });
});

describe('buildSyncIteration', () => {
  it('dispatches Sync_Iteration with correct argument shape', async () => {
    const transport = mockTransport('admin-after-iter1');
    await buildSyncIteration(
      transport,
      {
        adminCid: 'admin-before',
        operator: 'carol',
        iterationAmount: new Decimal('100'),
        newAllocationCid: 'alloc-002',
      },
      silentLogger,
    );
    expect(transport.exercise).toHaveBeenCalledOnce();
    const [tmpl, cid, choice, arg, actAs] = (transport.exercise as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(tmpl).toEqual(TEMPLATE_STREAM_ADMIN);
    expect(cid).toBe('admin-before');
    expect(choice).toBe('Sync_Iteration');
    expect(arg).toEqual({
      iterationAmount: { numeric: '100.0000000000' },
      newAllocationCid: { optional: { text: 'alloc-002' } },
    });
    expect(actAs).toEqual(['carol']);
  });

  it('encodes None for final iteration with no new cid', async () => {
    const transport = mockTransport();
    await buildSyncIteration(
      transport,
      {
        adminCid: 'admin-before',
        operator: 'carol',
        iterationAmount: new Decimal('100'),
      },
      silentLogger,
    );
    const [, , , arg] = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((arg as { newAllocationCid: unknown }).newAllocationCid).toEqual({ optional: null });
  });

  it('returns new admin cid + V2 version tag', async () => {
    const transport = mockTransport('admin-after');
    const result = await buildSyncIteration(
      transport,
      {
        adminCid: 'admin-before',
        operator: 'carol',
        iterationAmount: new Decimal('100'),
        newAllocationCid: 'alloc-002',
      },
      silentLogger,
    );
    expect(result.newAdminCid).toBe('admin-after');
    expect(result.version).toBe('v2');
  });
});

describe('buildMarkCancelled', () => {
  it('dispatches Mark_Cancelled with correct argument shape', async () => {
    const transport = mockTransport();
    const cancelAt = new Date('2026-03-15T00:00:00Z');
    await buildMarkCancelled(
      transport,
      {
        adminCid: 'admin-before',
        operator: 'carol',
        cancelTime: cancelAt,
        finalWithdrawn: new Decimal('300'),
      },
      silentLogger,
    );
    expect(transport.exercise).toHaveBeenCalledOnce();
    const [, , choice, arg, actAs] = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(choice).toBe('Mark_Cancelled');
    expect(arg).toEqual({
      cancelTime: { timestamp: (BigInt(cancelAt.getTime()) * 1000n).toString() },
      finalWithdrawn: { numeric: '300.0000000000' },
    });
    expect(actAs).toEqual(['carol']);
  });
});

describe('buildMarkCompleted', () => {
  it('dispatches Mark_Completed with empty argument', async () => {
    const transport = mockTransport();
    await buildMarkCompleted(
      transport,
      { adminCid: 'admin-before', operator: 'carol' },
      silentLogger,
    );
    expect(transport.exercise).toHaveBeenCalledOnce();
    const [, , choice, arg, actAs] = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(choice).toBe('Mark_Completed');
    expect(arg).toEqual({});
    expect(actAs).toEqual(['carol']);
  });
});
