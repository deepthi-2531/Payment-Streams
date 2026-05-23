/**
 * Unit tests for commands/allocation.ts — AllocationRequestV2 emission +
 * Allocation_Settle dispatch (STR-75, V2-only per STR-79).
 *
 * Covers:
 *   - Single-leg V2 payload shape
 *   - Multi-leg V2 payload shape
 *   - Account.owner encoding (Optional Party — the CIP-0112 update)
 *   - Iterated-allocation funding (V2 committed-iterated allocations)
 *   - Batch settlement via SettlementFactory_SettleBatch
 *   - PausedInstrumentError when caps.paused = true
 */

import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';

import {
  buildAllocationRequest,
  buildAllocationSettle,
  buildAllocationCancel,
  buildBatchSettlement,
  type AllocationSettlementInfo,
  type TransferLegV2,
} from '../../src/commands/allocation.js';
import { PausedInstrumentError, type AssetCapabilities } from '../../src/assets/capabilities.js';
import type { Transport, TemplateId } from '../../src/transport/base.js';

const TEMPLATE_V2: TemplateId = {
  packageId: 'pkg-v2',
  moduleName: 'CantonStreams.Stream.Escrow',
  entityName: 'StreamEscrow',
};
const TEMPLATE_SF: TemplateId = {
  packageId: 'pkg-v2',
  moduleName: 'Splice.Api.Token.AllocationV2',
  entityName: 'SettlementFactory',
};

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
  pauseInfo: 'admin-action pending review',
  source: 'registry',
};

const settlement: AllocationSettlementInfo = {
  executor: 'EscrowOperator::1',
  settlementRefId: 'stream-001:cycle-1',
  requestedAt: new Date('2026-01-01T00:00:00Z'),
  allocateBefore: new Date('2026-01-02T00:00:00Z'),
  meta: { streamId: 'stream-001' },
};

const v2Leg: TransferLegV2 = {
  sender: 'EscrowOperator::1',
  receiver: { owner: 'Recipient::alice', id: '' },
  amount: new Decimal('100.00'),
  instrumentId: { admin: 'TBD::v2-admin', id: 'v2-test' },
};

describe('buildAllocationRequest (V2)', () => {
  it('emits an AllocationRequestV2 payload with transferLegs map', () => {
    const result = buildAllocationRequest(
      v2Caps,
      { settlement, legs: [{ legId: 'leg-1', leg: v2Leg }] },
      TEMPLATE_V2,
    );
    expect(result.version).toBe('v2');
    expect(result.templateId).toBe(TEMPLATE_V2);
    const transferLegs = result.argument['transferLegs'] as Record<string, unknown>;
    expect(transferLegs['leg-1']).toBeDefined();
  });

  it('accepts multi-leg requests', () => {
    const result = buildAllocationRequest(
      v2Caps,
      {
        settlement,
        legs: [
          { legId: 'leg-1', leg: v2Leg },
          { legId: 'leg-2', leg: { ...v2Leg, receiver: { owner: 'Recipient::bob', id: '' } } },
        ],
      },
      TEMPLATE_V2,
    );
    expect(result.version).toBe('v2');
    const transferLegs = result.argument['transferLegs'] as Record<string, unknown>;
    expect(Object.keys(transferLegs)).toHaveLength(2);
  });

  it('serializes amounts in decimal notation (no scientific)', () => {
    const tinyLeg: TransferLegV2 = { ...v2Leg, amount: new Decimal('0.00000001') };
    const result = buildAllocationRequest(
      v2Caps,
      { settlement, legs: [{ legId: 'leg-1', leg: tinyLeg }] },
      TEMPLATE_V2,
    );
    const transferLegs = result.argument['transferLegs'] as Record<string, { amount: { numeric: string } }>;
    const amt = transferLegs['leg-1']!.amount.numeric;
    expect(amt).not.toContain('e');
    expect(amt).toBe('0.0000000100');
  });

  it('encodes Account.provider as Some when supplied', () => {
    const v2LegWithProvider: TransferLegV2 = {
      ...v2Leg,
      receiver: { owner: 'Recipient::alice', provider: 'Custodian::bank', id: 'acct-1' },
    };
    const result = buildAllocationRequest(
      v2Caps,
      { settlement, legs: [{ legId: 'leg-1', leg: v2LegWithProvider }] },
      TEMPLATE_V2,
    );
    const transferLegs = result.argument['transferLegs'] as Record<string, { receiver: { provider: { optional: unknown } } }>;
    expect(transferLegs['leg-1']!.receiver.provider.optional).toEqual({ party: 'Custodian::bank' });
  });

  it('encodes Account.owner as Some when supplied (per the CIP-0112 update — Optional Party)', () => {
    const result = buildAllocationRequest(
      v2Caps,
      { settlement, legs: [{ legId: 'leg-1', leg: v2Leg }] },
      TEMPLATE_V2,
    );
    const transferLegs = result.argument['transferLegs'] as Record<string, { receiver: { owner: { optional: unknown } } }>;
    expect(transferLegs['leg-1']!.receiver.owner.optional).toEqual({ party: 'Recipient::alice' });
  });

  it('encodes Account.owner as None for ownerless registry burn/mint accounts', () => {
    const burnLeg: TransferLegV2 = {
      ...v2Leg,
      // ownerless account — registry burn/mint pattern per the CIP-0112 update
      receiver: { id: '' },
    };
    const result = buildAllocationRequest(
      v2Caps,
      { settlement, legs: [{ legId: 'leg-1', leg: burnLeg }] },
      TEMPLATE_V2,
    );
    const transferLegs = result.argument['transferLegs'] as Record<string, { receiver: { owner: { optional: unknown } } }>;
    expect(transferLegs['leg-1']!.receiver.owner.optional).toBeNull();
  });

  it('throws PausedInstrumentError when caps.paused = true', () => {
    expect(() =>
      buildAllocationRequest(
        pausedCaps,
        { settlement, legs: [{ legId: 'leg-1', leg: v2Leg }] },
        TEMPLATE_V2,
      ),
    ).toThrow(PausedInstrumentError);
  });
});

describe('buildAllocationSettle (V2)', () => {
  const mockTransport = (): Transport => ({
    create: vi.fn(),
    exercise: vi.fn().mockResolvedValue({ settledLegIds: ['leg-1'] }),
    exerciseByKey: vi.fn(),
    query: vi.fn(),
    queryByContractId: vi.fn(),
    fetchLatestEvents: vi.fn(),
  } as unknown as Transport);

  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

  it('exercises Allocation_Settle on the V2 template (default no iteration)', async () => {
    const transport = mockTransport();
    await buildAllocationSettle(transport, v2Caps, 'alloc-1', TEMPLATE_V2, ['exec'], logger);
    expect(transport.exercise).toHaveBeenCalledWith(
      TEMPLATE_V2,
      'alloc-1',
      'Allocation_Settle',
      expect.objectContaining({ nextIterationFunding: { optional: null } }),
      ['exec'],
    );
  });

  it('passes nextIterationFunding for iterated settlement (V2 committed-iterated primitive)', async () => {
    const transport = mockTransport();
    await buildAllocationSettle(transport, v2Caps, 'alloc-1', TEMPLATE_V2, ['exec'], logger, {
      nextIterationFunding: {
        amount: new Decimal('50'),
        holdingCids: ['h-1', 'h-2'],
        nextSettleBefore: new Date('2026-02-01T00:00:00Z'),
      },
    });
    const call = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const arg = call[3] as { nextIterationFunding: { optional: { holdingCids: unknown[] } } };
    expect(arg.nextIterationFunding.optional.holdingCids).toHaveLength(2);
  });

  it('throws PausedInstrumentError when caps.paused = true', async () => {
    const transport = mockTransport();
    await expect(
      buildAllocationSettle(transport, pausedCaps, 'alloc-1', TEMPLATE_V2, ['exec'], logger),
    ).rejects.toThrow(PausedInstrumentError);
  });
});

describe('buildAllocationCancel (V2)', () => {
  const mockTransport = (): Transport => ({
    create: vi.fn(),
    exercise: vi.fn().mockResolvedValue({}),
    exerciseByKey: vi.fn(),
    query: vi.fn(),
    queryByContractId: vi.fn(),
    fetchLatestEvents: vi.fn(),
  } as unknown as Transport);

  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

  it('exercises Allocation_Cancel on the V2 template', async () => {
    const transport = mockTransport();
    await buildAllocationCancel(transport, v2Caps, 'alloc-1', TEMPLATE_V2, ['actor'], logger);
    expect(transport.exercise).toHaveBeenCalledWith(
      TEMPLATE_V2,
      'alloc-1',
      'Allocation_Cancel',
      expect.objectContaining({ extraArgs: expect.any(Object) }),
      ['actor'],
    );
  });
});

describe('buildBatchSettlement (V2)', () => {
  const mockTransport = (): Transport => ({
    create: vi.fn(),
    exercise: vi.fn().mockResolvedValue({}),
    exerciseByKey: vi.fn(),
    query: vi.fn(),
    queryByContractId: vi.fn(),
    fetchLatestEvents: vi.fn(),
  } as unknown as Transport);

  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

  it('serializes per-leg allocation cids', async () => {
    const transport = mockTransport();
    await buildBatchSettlement(
      transport,
      v2Caps,
      'sf-1',
      TEMPLATE_SF,
      { 'leg-1': 'a-1', 'leg-2': 'a-2' },
      ['exec'],
      logger,
    );
    const call = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const arg = call[3] as { allocationCids: Record<string, { contractId: string }> };
    expect(arg.allocationCids['leg-1']).toEqual({ contractId: 'a-1' });
    expect(arg.allocationCids['leg-2']).toEqual({ contractId: 'a-2' });
  });

  it('throws PausedInstrumentError when caps.paused = true', async () => {
    const transport = mockTransport();
    await expect(
      buildBatchSettlement(transport, pausedCaps, 'sf-1', TEMPLATE_SF, { 'leg-1': 'a-1' }, ['exec'], logger),
    ).rejects.toThrow(PausedInstrumentError);
  });
});
