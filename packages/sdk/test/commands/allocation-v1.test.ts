/**
 * Unit tests for commands/allocation-v1.ts — the transitional CIP-56 V1
 * settlement lane. This file is deleted together with the lane.
 *
 * Covers:
 *   - buildAllocationRequestV1 wire shape (SettlementInfo, transferLegs map)
 *   - deadline defaults (allocateBefore = requestedAt, settleBefore = +5m)
 *   - multi-leg encoding
 *   - Allocation_ExecuteTransfer / Cancel / Withdraw choice dispatch
 *   - choice-context encoding into extraArgs
 *   - lane gating: V1 actions rejected for assets without allocationsV1
 */

import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';

import {
  buildAllocationRequestV1,
  buildAllocationExecuteTransferV1,
  buildAllocationCancelV1,
  buildAllocationWithdrawV1,
  type BuildAllocationRequestV1Params,
} from '../../src/commands/allocation-v1.js';
import type { AssetCapabilities } from '../../src/assets/capabilities.js';
import type { Transport, TemplateId } from '../../src/transport/base.js';

const TEMPLATE_V1: TemplateId = { packageId: 'p1', moduleName: 'M', entityName: 'StreamV1Request' };

const v1Caps: AssetCapabilities = {
  key: 'cc',
  allocationsV2: false,
  allocationsV1: true,
  transferEventsV2: false,
  paused: false,
  source: 'registry',
};

const v2OnlyCaps: AssetCapabilities = {
  key: 'v2-asset',
  allocationsV2: true,
  allocationsV1: false,
  transferEventsV2: true,
  paused: false,
  source: 'registry',
};

function mockTransport(): Transport {
  return {
    create: vi.fn().mockResolvedValue({ contractId: 'cid-created', result: {} }),
    exercise: vi.fn().mockResolvedValue({ ok: true }),
    exerciseByKey: vi.fn(),
    query: vi.fn(),
  } as unknown as Transport;
}

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function baseParams(overrides: Partial<BuildAllocationRequestV1Params> = {}): BuildAllocationRequestV1Params {
  return {
    requestedBy: 'EscrowOperator::1',
    settlement: {
      executor: 'EscrowOperator::1',
      settlementRefId: 'stream-001:cycle-1',
      requestedAt: new Date('2026-01-01T00:00:00Z'),
    },
    legs: [{
      legId: 'leg-1',
      leg: {
        sender: 'Sender::treasury',
        receiver: 'Recipient::alice',
        amount: new Decimal('100'),
        instrumentId: { admin: 'CCAdmin::1220', id: 'Amulet' },
      },
    }],
    ...overrides,
  };
}

describe('buildAllocationRequestV1', () => {
  it('produces a v1 payload with single-executor SettlementInfo and a transferLegs map', () => {
    const payload = buildAllocationRequestV1(v1Caps, baseParams(), TEMPLATE_V1);

    expect(payload.version).toBe('v1');
    expect(payload.templateId).toBe(TEMPLATE_V1);

    expect(payload.argument['requestedBy']).toEqual({ party: 'EscrowOperator::1' });
    const settlement = payload.argument['settlement'] as Record<string, unknown>;
    expect(settlement['executor']).toEqual({ party: 'EscrowOperator::1' });
    const ref = settlement['settlementRef'] as Record<string, unknown>;
    expect(ref['id']).toEqual({ text: 'stream-001:cycle-1' });
    expect(ref['cid']).toEqual({ optional: null });

    const legs = payload.argument['transferLegs'] as {
      text_map: { entries: Array<{ key: string; value: Record<string, unknown> }> };
    };
    expect(legs.text_map.entries).toHaveLength(1);
    expect(legs.text_map.entries[0]!.key).toBe('leg-1');
    const leg = legs.text_map.entries[0]!.value;
    expect(leg['sender']).toEqual({ party: 'Sender::treasury' });
    expect(leg['receiver']).toEqual({ party: 'Recipient::alice' });
    expect(leg['amount']).toEqual({ numeric: '100.0000000000' });
    expect(leg['instrumentId']).toEqual({
      admin: { party: 'CCAdmin::1220' },
      id: { text: 'Amulet' },
    });
  });

  it('stamps the attribution metadata on the settlement (caller keys win)', () => {
    const payload = buildAllocationRequestV1(v1Caps, baseParams(), TEMPLATE_V1);
    const settlement = payload.argument['settlement'] as {
      meta: { values: { text_map: { entries: Array<{ key: string; value: { text: string } }> } } };
    };
    const entries = Object.fromEntries(
      settlement.meta.values.text_map.entries.map((e) => [e.key, e.value.text]),
    );
    expect(entries['cantonstreams.dev/ref']).toBe('stream-001:cycle-1');
    expect(entries['cantonstreams.dev/v']).toBe('1');

    // caller-supplied value for the same key wins
    const custom = buildAllocationRequestV1(v1Caps, baseParams({
      settlement: {
        executor: 'EscrowOperator::1',
        settlementRefId: 'stream-001:cycle-1',
        requestedAt: new Date('2026-01-01T00:00:00Z'),
        meta: { 'cantonstreams.dev/ref': 'override' },
      },
    }), TEMPLATE_V1);
    const customSettlement = custom.argument['settlement'] as typeof settlement;
    const customEntries = Object.fromEntries(
      customSettlement.meta.values.text_map.entries.map((e) => [e.key, e.value.text]),
    );
    expect(customEntries['cantonstreams.dev/ref']).toBe('override');
  });

  it('defaults allocateBefore to requestedAt and settleBefore to +5 minutes', () => {
    const payload = buildAllocationRequestV1(v1Caps, baseParams(), TEMPLATE_V1);
    const settlement = payload.argument['settlement'] as Record<string, { timestamp?: string }>;
    const requestedMicros = BigInt(Date.parse('2026-01-01T00:00:00Z')) * 1000n;
    expect(settlement['requestedAt']!.timestamp).toBe(requestedMicros.toString());
    expect(settlement['allocateBefore']!.timestamp).toBe(requestedMicros.toString());
    expect(settlement['settleBefore']!.timestamp).toBe(
      (requestedMicros + 5n * 60n * 1_000_000n).toString(),
    );
  });

  it('encodes multiple legs under their leg ids', () => {
    const params = baseParams({
      legs: [
        {
          legId: 'leg-1',
          leg: {
            sender: 'S::1', receiver: 'R::1',
            amount: new Decimal('10'),
            instrumentId: { admin: 'A::1', id: 'CC' },
          },
        },
        {
          legId: 'leg-2',
          leg: {
            sender: 'S::1', receiver: 'R::2',
            amount: new Decimal('20'),
            instrumentId: { admin: 'A::1', id: 'CC' },
          },
        },
      ],
    });
    const payload = buildAllocationRequestV1(v1Caps, params, TEMPLATE_V1);
    const legs = payload.argument['transferLegs'] as {
      text_map: { entries: Array<{ key: string }> };
    };
    expect(legs.text_map.entries.map((e) => e.key)).toEqual(['leg-1', 'leg-2']);
  });

  it('rejects an empty executor party', () => {
    const params = baseParams({
      settlement: {
        executor: '  ',
        settlementRefId: 'ref',
        requestedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    expect(() => buildAllocationRequestV1(v1Caps, params, TEMPLATE_V1)).toThrow(/executor/);
  });

  it('rejects assets that do not support V1 allocations', () => {
    expect(() => buildAllocationRequestV1(v2OnlyCaps, baseParams(), TEMPLATE_V1))
      .toThrow(/does not support V1 allocations/);
  });
});

describe('V1 Allocation choice exercises', () => {
  it('exercises Allocation_ExecuteTransfer with empty extraArgs when no context given', async () => {
    const transport = mockTransport();
    const result = await buildAllocationExecuteTransferV1(
      transport, v1Caps, 'alloc-cid-1', TEMPLATE_V1, ['EscrowOperator::1'], mockLogger(),
    );
    expect(result.version).toBe('v1');
    expect(transport.exercise).toHaveBeenCalledWith(
      TEMPLATE_V1,
      'alloc-cid-1',
      'Allocation_ExecuteTransfer',
      {
        extraArgs: {
          context: { values: { text_map: { entries: [] } } },
          meta: { values: { text_map: { entries: [] } } },
        },
      },
      ['EscrowOperator::1'],
      undefined,
      undefined,
    );
  });

  it('threads the registry choice context into extraArgs.context.values', async () => {
    const transport = mockTransport();
    await buildAllocationExecuteTransferV1(
      transport, v1Caps, 'alloc-cid-1', TEMPLATE_V1, ['EscrowOperator::1'], mockLogger(),
      { context: { values: { 'amulet-rules': { contract_id: 'rules-cid' } } } },
    );
    const arg = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0]![3] as {
      extraArgs: { context: { values: { text_map: { entries: Array<{ key: string; value: unknown }> } } } };
    };
    expect(arg.extraArgs.context.values.text_map.entries).toEqual([
      { key: 'amulet-rules', value: { contract_id: 'rules-cid' } },
    ]);
  });

  it('exercises Allocation_Cancel and Allocation_Withdraw with the v1 envelope', async () => {
    const transport = mockTransport();
    await buildAllocationCancelV1(
      transport, v1Caps, 'alloc-cid-2', TEMPLATE_V1, ['EscrowOperator::1'], mockLogger(),
    );
    await buildAllocationWithdrawV1(
      transport, v1Caps, 'alloc-cid-3', TEMPLATE_V1, ['Sender::treasury'], mockLogger(),
    );
    const calls = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![2]).toBe('Allocation_Cancel');
    expect(calls[1]![2]).toBe('Allocation_Withdraw');
  });
});
