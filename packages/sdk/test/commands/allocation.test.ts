/**
 * Unit tests for commands/allocation.ts — AllocationRequestV2 emission +
 * Allocation_Settle dispatch.
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
  allocationsV1: false,
  transferEventsV2: true,
  paused: false,
  source: 'registry',
};

const pausedCaps: AssetCapabilities = {
  key: 'paused-asset',
  allocationsV2: true,
  allocationsV1: false,
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
  it('emits an AllocationRequestV2 payload with allocations list', () => {
    const result = buildAllocationRequest(
      v2Caps,
      { settlement, legs: [{ legId: 'leg-1', leg: v2Leg }] },
      TEMPLATE_V2,
    );
    expect(result.version).toBe('v2');
    expect(result.templateId).toBe(TEMPLATE_V2);
    const settlementArg = result.argument['settlement'] as { executors: unknown[] };
    expect(settlementArg.executors).toEqual([{ party: 'EscrowOperator::1' }]);
    const allocations = result.argument['allocations'] as Array<{ transferLegSides: unknown[] }>;
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.transferLegSides).toHaveLength(1);
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
    const allocations = result.argument['allocations'] as unknown[];
    expect(allocations).toHaveLength(2);
  });

  it('serializes amounts in decimal notation (no scientific)', () => {
    const tinyLeg: TransferLegV2 = { ...v2Leg, amount: new Decimal('0.00000001') };
    const result = buildAllocationRequest(
      v2Caps,
      { settlement, legs: [{ legId: 'leg-1', leg: tinyLeg }] },
      TEMPLATE_V2,
    );
    const allocations = result.argument['allocations'] as Array<{ transferLegSides: Array<{ amount: { numeric: string } }> }>;
    const amt = allocations[0]!.transferLegSides[0]!.amount.numeric;
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
    const allocations = result.argument['allocations'] as Array<{ transferLegSides: Array<{ otherside: { provider: { optional: unknown } } }> }>;
    expect(allocations[0]!.transferLegSides[0]!.otherside.provider.optional).toEqual({ party: 'Custodian::bank' });
  });

  it('encodes Account.owner as Some when supplied (per the CIP-0112 update — Optional Party)', () => {
    const result = buildAllocationRequest(
      v2Caps,
      { settlement, legs: [{ legId: 'leg-1', leg: v2Leg }] },
      TEMPLATE_V2,
    );
    const allocations = result.argument['allocations'] as Array<{ transferLegSides: Array<{ otherside: { owner: { optional: unknown } } }> }>;
    expect(allocations[0]!.transferLegSides[0]!.otherside.owner.optional).toEqual({ party: 'Recipient::alice' });
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
    const allocations = result.argument['allocations'] as Array<{ transferLegSides: Array<{ otherside: { owner: { optional: unknown } } }> }>;
    expect(allocations[0]!.transferLegSides[0]!.otherside.owner.optional).toBeNull();
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
      expect.objectContaining({
        actors: [{ party: 'exec' }],
        extraTransferLegSides: [],
        nextIterationFunding: { optional: null },
      }),
      ['exec'],
    );
  });

  it('passes nextIterationFunding for iterated settlement (V2 committed-iterated primitive)', async () => {
    const transport = mockTransport();
    await buildAllocationSettle(transport, v2Caps, 'alloc-1', TEMPLATE_V2, ['exec'], logger, {
      nextIterationFunding: {
        amounts: { 'v2-test': new Decimal('50') },
      },
    });
    const call = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const arg = call[3] as {
      nextIterationFunding: { optional: { text_map: { entries: Array<{ key: string }> } } };
    };
    expect(arg.nextIterationFunding.optional.text_map.entries).toEqual([
      { key: 'v2-test', value: { numeric: '50.0000000000' } },
    ]);
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
      expect.objectContaining({ actors: [{ party: 'actor' }], extraArgs: expect.any(Object) }),
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

  it('serializes standard batch settlement arguments', async () => {
    const transport = mockTransport();
    await buildBatchSettlement(
      transport,
      v2Caps,
      'sf-1',
      TEMPLATE_SF,
      {
        settlement,
        transferLegs: [
          {
            transferLegId: 'leg-1',
            sender: { owner: 'EscrowOperator::1', id: '' },
            receiver: { owner: 'Recipient::alice', id: '' },
            amount: new Decimal('100'),
            instrumentId: 'v2-test',
          },
        ],
        allocations: [
          {
            allocationCid: 'a-1',
            nextIterationFunding: { amounts: { 'v2-test': new Decimal('50') } },
          },
        ],
      },
      ['exec'],
      logger,
    );
    const call = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const arg = call[3] as {
      settlement: { executors: unknown[] };
      transferLegs: unknown[];
      allocations: Array<{ allocationCid: { contract_id: string } }>;
      actors: unknown[];
    };
    expect(arg.settlement.executors).toEqual([{ party: 'EscrowOperator::1' }]);
    expect(arg.transferLegs).toHaveLength(1);
    expect(arg.allocations[0]!.allocationCid).toEqual({ contract_id: 'a-1' });
    expect(arg.actors).toEqual([{ party: 'exec' }]);
  });

  it('throws PausedInstrumentError when caps.paused = true', async () => {
    const transport = mockTransport();
    await expect(
      buildBatchSettlement(
        transport,
        pausedCaps,
        'sf-1',
        TEMPLATE_SF,
        { settlement, transferLegs: [], allocations: [] },
        ['exec'],
        logger,
      ),
    ).rejects.toThrow(PausedInstrumentError);
  });
});

// ---------------------------------------------------------------------------
// Upstream V2 conformance lock-in
//
// These tests pin the exact wire-field names against upstream V2 spec at
// SPLICE_PINNED_COMMIT (recorded in scripts/fetch-v2-dars.mjs). If
// upstream renames a field, these tests fail loudly and the maintainer
// must update both this fixture and the SDK builder in lockstep.
//
// Reference sources (read at commit 2f2a8b94871bc9d68ae5bdbe7198b0c69a5fa9ea):
//   - splice-api-token-allocation-v2 / AllocationV2.daml
//   - splice-api-token-allocation-request-v2 / AllocationRequestV2.daml
//   - splice-api-token-allocation-instruction-v2 / AllocationInstructionV2.daml
// ---------------------------------------------------------------------------

describe('V2 upstream conformance', () => {
  it('AllocationRequest argument carries upstream field names', () => {
    const result = buildAllocationRequest(
      v2Caps,
      {
        settlement,
        legs: [{ legId: 'leg-1', leg: v2Leg }],
        originalRequestCid: 'prior-request-cid',
      },
      TEMPLATE_V2,
    );

    const arg = result.argument as Record<string, unknown>;
    // Required upstream fields
    expect(arg).toHaveProperty('settlement');
    expect(arg).toHaveProperty('allocations');
    expect(arg).toHaveProperty('requestedAt');
    expect(arg).toHaveProperty('settleAt');
    expect(arg).toHaveProperty('availableActions');
    expect(arg).toHaveProperty('meta');
    // The renamed-from-V1 field — upstream uses `originalRequestCid`,
    // NOT `originalRequestId`.
    expect(arg).toHaveProperty('originalRequestCid');
    expect(arg).not.toHaveProperty('originalRequestId');

    // `settlement.executors` (plural list), NOT `settlement.executor` (single).
    const settlementArg = arg['settlement'] as Record<string, unknown>;
    expect(settlementArg).toHaveProperty('executors');
    expect(settlementArg).not.toHaveProperty('executor');
    expect(Array.isArray(settlementArg['executors'])).toBe(true);

    // `allocations` is an array of records, NOT a map keyed by legId.
    expect(Array.isArray(arg['allocations'])).toBe(true);
    expect(arg).not.toHaveProperty('transferLegs');

    // originalRequestCid encodes via `optional` + `contract_id`
    expect(arg['originalRequestCid']).toEqual({
      optional: { contract_id: 'prior-request-cid' },
    });
  });

  it('Allocation_Settle argument matches upstream V2 choice signature', async () => {
    const transport = {
      create: vi.fn(),
      exercise: vi.fn().mockResolvedValue({}),
      exerciseByKey: vi.fn(),
      query: vi.fn(),
      queryByContractId: vi.fn(),
      fetchLatestEvents: vi.fn(),
    } as unknown as Transport;
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

    await buildAllocationSettle(transport, v2Caps, 'alloc-1', TEMPLATE_V2, ['exec'], logger, {
      nextIterationFunding: { amounts: { 'inst-A': new Decimal('99.5') } },
    });

    const call = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const choiceName = call[2];
    const arg = call[3] as Record<string, unknown>;

    // Choice name must be V2's Allocation_Settle (not the V1 name).
    expect(choiceName).toBe('Allocation_Settle');

    // Upstream V2 choice fields:
    //   actors             : [Party]
    //   extraTransferLegSides : [TransferLegSide]
    //   nextIterationFunding : Optional (TextMap Decimal)
    //   extraArgs          : ExtraArgs
    expect(Object.keys(arg).sort()).toEqual(
      ['actors', 'extraArgs', 'extraTransferLegSides', 'nextIterationFunding'].sort(),
    );

    // nextIterationFunding is `Optional (TextMap Decimal)` — the wire
    // shape is `{ optional: { text_map: { entries: [{key, value: {numeric}}] } } }`.
    expect(arg['nextIterationFunding']).toEqual({
      optional: {
        text_map: { entries: [{ key: 'inst-A', value: { numeric: '99.5000000000' } }] },
      },
    });
  });

  it('SettlementFactory_SettleBatch argument matches upstream V2 choice signature', async () => {
    const transport = {
      create: vi.fn(),
      exercise: vi.fn().mockResolvedValue({}),
      exerciseByKey: vi.fn(),
      query: vi.fn(),
      queryByContractId: vi.fn(),
      fetchLatestEvents: vi.fn(),
    } as unknown as Transport;
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

    await buildBatchSettlement(
      transport,
      v2Caps,
      'sf-1',
      TEMPLATE_SF,
      {
        settlement,
        transferLegs: [
          {
            transferLegId: 'leg-1',
            sender: { owner: 'EscrowOperator::1', id: '' },
            receiver: { owner: 'Recipient::alice', id: '' },
            amount: new Decimal('100'),
            instrumentId: 'inst-A',
          },
        ],
        allocations: [{ allocationCid: 'a-1' }],
      },
      ['exec'],
      logger,
    );

    const call = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[2]).toBe('SettlementFactory_SettleBatch');

    const arg = call[3] as Record<string, unknown>;
    // Upstream V2 choice fields:
    //   settlement    : SettlementInfo
    //   transferLegs  : [TransferLeg]      -- top-level list, not a map
    //   allocations   : [FinalizedAllocation]
    //   actors        : [Party]
    //   extraArgs     : ExtraArgs
    expect(Object.keys(arg).sort()).toEqual(
      ['actors', 'allocations', 'extraArgs', 'settlement', 'transferLegs'].sort(),
    );

    expect(Array.isArray(arg['transferLegs'])).toBe(true);
    expect(Array.isArray(arg['allocations'])).toBe(true);

    // Make sure we do not emit the old `allocationCids` map shape.
    expect(arg).not.toHaveProperty('allocationCids');
  });

  it('AllocationRequest does NOT emit the legacy `executor` singular field', () => {
    const result = buildAllocationRequest(
      v2Caps,
      { settlement, legs: [{ legId: 'leg-1', leg: v2Leg }] },
      TEMPLATE_V2,
    );
    const settlementArg = result.argument['settlement'] as Record<string, unknown>;
    expect(settlementArg).not.toHaveProperty('executor');
  });
});
