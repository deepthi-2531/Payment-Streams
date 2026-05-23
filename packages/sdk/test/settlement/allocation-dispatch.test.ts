/**
 * Unit tests for settlement/allocation-dispatch.ts (STR-76, V2-only per STR-79).
 *
 * Covers:
 *   - V2 routing for emit-request, settle, cancel, batch-settle
 *   - PausedInstrumentError when caps.paused = true
 *   - Iterated settlement (nextIterationFunding)
 */

import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';

import {
  dispatchSettlement,
  buildWithdrawalRequestCommand,
  buildWithdrawalSettleCommand,
} from '../../src/settlement/allocation-dispatch.js';
import { PausedInstrumentError, type AssetCapabilities } from '../../src/assets/capabilities.js';
import type { Transport, TemplateId } from '../../src/transport/base.js';

const TEMPLATE_V2: TemplateId = { packageId: 'p2', moduleName: 'M', entityName: 'StreamEscrow' };
const TEMPLATE_SF: TemplateId = { packageId: 'p2', moduleName: 'SF', entityName: 'SettlementFactory' };

const v2Caps: AssetCapabilities = {
  key: 'v2-asset',
  allocationsV2: true,
  transferEventsV2: true,
  paused: false,
  source: 'registry',
};

const pausedCaps: AssetCapabilities = {
  key: 'paused-asset',
  allocationsV2: true,
  transferEventsV2: true,
  paused: true,
  pauseInfo: 'admin review',
  source: 'registry',
};

function mockTransport(): Transport {
  return {
    create: vi.fn().mockResolvedValue({ contractId: 'cid-created', result: {} }),
    exercise: vi.fn().mockResolvedValue({}),
    exerciseByKey: vi.fn(),
    query: vi.fn(),
    queryByContractId: vi.fn(),
    fetchLatestEvents: vi.fn(),
  } as unknown as Transport;
}

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

describe('dispatchSettlement — emit-request', () => {
  it('creates an AllocationRequestV2 on V2 caps', async () => {
    const transport = mockTransport();
    const logger = mockLogger();
    const cmd = buildWithdrawalRequestCommand({
      settlement: {
        executor: 'EscrowOperator::1',
        settlementRefId: 'stream-001:cycle-1',
        requestedAt: new Date('2026-01-01T00:00:00Z'),
        allocateBefore: new Date('2026-01-02T00:00:00Z'),
      },
      legs: [{
        legId: 'leg-1',
        leg: {
          sender: 'EscrowOperator::1',
          receiver: { owner: 'Recipient::alice', id: '' },
          amount: new Decimal('100'),
          instrumentId: { admin: 'admin-1', id: 'asset-1' },
        },
      }],
      templateId: TEMPLATE_V2,
      actAs: ['EscrowOperator::1'],
    });
    const result = await dispatchSettlement(transport, v2Caps, cmd, logger);
    expect(result.version).toBe('v2');
    expect(result.action).toBe('emit-request');
    expect(transport.create).toHaveBeenCalledWith(TEMPLATE_V2, expect.any(Object), ['EscrowOperator::1']);
  });

  it('throws PausedInstrumentError on paused caps', async () => {
    const transport = mockTransport();
    const logger = mockLogger();
    const cmd = buildWithdrawalRequestCommand({
      settlement: {
        executor: 'EscrowOperator::1',
        settlementRefId: 'x',
        requestedAt: new Date(),
      },
      legs: [{
        legId: 'leg-1',
        leg: {
          sender: 'a', receiver: { owner: 'b', id: '' },
          amount: new Decimal('1'), instrumentId: { admin: 'x', id: 'y' },
        },
      }],
      templateId: TEMPLATE_V2,
      actAs: ['x'],
    });
    await expect(dispatchSettlement(transport, pausedCaps, cmd, logger))
      .rejects.toThrow(PausedInstrumentError);
  });
});

describe('dispatchSettlement — settle / cancel / batch-settle', () => {
  it('settle on V2 caps exercises Allocation_Settle', async () => {
    const transport = mockTransport();
    const logger = mockLogger();
    const cmd = buildWithdrawalSettleCommand({
      allocationCid: 'alloc-1',
      templateId: TEMPLATE_V2,
      actAs: ['exec'],
    });
    const result = await dispatchSettlement(transport, v2Caps, cmd, logger);
    expect(result.action).toBe('settle');
    expect(result.version).toBe('v2');
    expect(transport.exercise).toHaveBeenCalledWith(
      TEMPLATE_V2, 'alloc-1', 'Allocation_Settle',
      expect.any(Object), ['exec'],
    );
  });

  it('settle with nextIterationFunding (iterated)', async () => {
    const transport = mockTransport();
    const logger = mockLogger();
    const cmd = buildWithdrawalSettleCommand({
      allocationCid: 'alloc-1',
      templateId: TEMPLATE_V2,
      actAs: ['exec'],
      nextIterationFunding: {
        amount: new Decimal('70'),
        holdingCids: ['h-1'],
        nextSettleBefore: new Date('2026-02-01T00:00:00Z'),
      },
    });
    await dispatchSettlement(transport, v2Caps, cmd, logger);
    const call = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const arg = call[3] as { nextIterationFunding: { optional: { holdingCids: unknown[] } } };
    expect(arg.nextIterationFunding.optional.holdingCids).toHaveLength(1);
  });

  it('cancel exercises Allocation_Cancel', async () => {
    const transport = mockTransport();
    const logger = mockLogger();
    await dispatchSettlement(transport, v2Caps, {
      action: 'cancel', allocationCid: 'alloc-1',
      templateId: TEMPLATE_V2, actAs: ['sender'],
    }, logger);
    expect(transport.exercise).toHaveBeenCalledWith(
      TEMPLATE_V2, 'alloc-1', 'Allocation_Cancel',
      expect.any(Object), ['sender'],
    );
  });

  it('batch-settle exercises SettlementFactory_SettleBatch', async () => {
    const transport = mockTransport();
    const logger = mockLogger();
    const result = await dispatchSettlement(transport, v2Caps, {
      action: 'batch-settle',
      settlementFactoryCid: 'sf-1',
      templateIdSettlementFactory: TEMPLATE_SF,
      allocationCids: { 'leg-1': 'a-1', 'leg-2': 'a-2' },
      actAs: ['exec'],
    }, logger);
    expect(result.version).toBe('v2');
    expect(transport.exercise).toHaveBeenCalledWith(
      TEMPLATE_SF, 'sf-1', 'SettlementFactory_SettleBatch',
      expect.any(Object), ['exec'],
    );
  });

  it('paused caps blocks settle', async () => {
    const transport = mockTransport();
    const logger = mockLogger();
    const cmd = buildWithdrawalSettleCommand({
      allocationCid: 'alloc-1', templateId: TEMPLATE_V2, actAs: ['exec'],
    });
    await expect(dispatchSettlement(transport, pausedCaps, cmd, logger))
      .rejects.toThrow(PausedInstrumentError);
  });
});
