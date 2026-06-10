/**
 * Unit tests for the V1 settlement lane in settlement/allocation-dispatch.ts
 * plus lane resolution and registry acceptance of V1-only assets.
 * This file is deleted together with the lane.
 *
 * Covers:
 *   - dispatchSettlementV1 routing for emit-request / settle / cancel / withdraw
 *   - PausedInstrumentError on the V1 lane
 *   - V1 dispatch rejected for assets without allocationsV1
 *   - resolveSettlementVersion preference + validation rules
 *   - registry load: V1-only asset accepted, neither-lane asset rejected
 *   - V1 lane denies iterated / batch actions
 */

import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';

import {
  dispatchSettlementV1,
  resolveSettlementVersion,
  type DispatchCommandV1,
} from '../../src/settlement/allocation-dispatch.js';
import {
  assertActionSupported,
  PausedInstrumentError,
  type AssetCapabilities,
} from '../../src/assets/capabilities.js';
import { loadAssetRegistry, type AssetConfig } from '../../src/assets/registry.js';
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

const dualCaps: AssetCapabilities = {
  key: 'dual-asset',
  allocationsV2: true,
  allocationsV1: true,
  transferEventsV2: true,
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

const pausedV1Caps: AssetCapabilities = { ...v1Caps, paused: true, pauseInfo: 'admin review' };

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

function emitRequestCmd(): DispatchCommandV1 {
  return {
    action: 'emit-request',
    request: {
      requestedBy: 'Sender::treasury',
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
    },
    templateId: TEMPLATE_V1,
    actAs: ['Sender::treasury'],
  };
}

describe('dispatchSettlementV1 — routing', () => {
  it('emit-request creates the V1 AllocationRequest payload', async () => {
    const transport = mockTransport();
    const result = await dispatchSettlementV1(transport, v1Caps, emitRequestCmd(), mockLogger());
    expect(result.version).toBe('v1');
    expect(result.action).toBe('emit-request');
    expect(transport.create).toHaveBeenCalledOnce();
  });

  it('settle exercises Allocation_ExecuteTransfer', async () => {
    const transport = mockTransport();
    const result = await dispatchSettlementV1(transport, v1Caps, {
      action: 'settle',
      allocationCid: 'alloc-1',
      templateId: TEMPLATE_V1,
      actAs: ['EscrowOperator::1'],
    }, mockLogger());
    expect(result.version).toBe('v1');
    const call = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[2]).toBe('Allocation_ExecuteTransfer');
  });

  it('cancel and withdraw route their V1 choices', async () => {
    const transport = mockTransport();
    await dispatchSettlementV1(transport, v1Caps, {
      action: 'cancel', allocationCid: 'a', templateId: TEMPLATE_V1, actAs: ['Op::1'],
    }, mockLogger());
    await dispatchSettlementV1(transport, v1Caps, {
      action: 'withdraw', allocationCid: 'b', templateId: TEMPLATE_V1, actAs: ['S::1'],
    }, mockLogger());
    const calls = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![2]).toBe('Allocation_Cancel');
    expect(calls[1]![2]).toBe('Allocation_Withdraw');
  });

  it('throws PausedInstrumentError when the asset is paused', async () => {
    await expect(
      dispatchSettlementV1(mockTransport(), pausedV1Caps, emitRequestCmd(), mockLogger()),
    ).rejects.toBeInstanceOf(PausedInstrumentError);
  });

  it('rejects V1 dispatch for an asset without allocationsV1', async () => {
    await expect(
      dispatchSettlementV1(mockTransport(), v2OnlyCaps, emitRequestCmd(), mockLogger()),
    ).rejects.toThrow(/does not support V1 allocations/);
  });
});

describe('resolveSettlementVersion', () => {
  it('prefers V2 when both lanes are available', () => {
    expect(resolveSettlementVersion(dualCaps)).toBe('v2');
  });

  it('falls back to V1 for V1-only assets', () => {
    expect(resolveSettlementVersion(v1Caps)).toBe('v1');
  });

  it('honors an explicit preference when supported', () => {
    expect(resolveSettlementVersion(dualCaps, 'v1')).toBe('v1');
    expect(resolveSettlementVersion(dualCaps, 'v2')).toBe('v2');
  });

  it('rejects an explicit preference the asset cannot satisfy', () => {
    expect(() => resolveSettlementVersion(v1Caps, 'v2')).toThrow(/does not support V2/);
    expect(() => resolveSettlementVersion(v2OnlyCaps, 'v1')).toThrow(/does not support V1/);
  });
});

describe('V1 lane action gating', () => {
  it('denies iterated and batch actions on the V1 lane', () => {
    expect(() => assertActionSupported(v1Caps, 'allocation-iterated'))
      .toThrow(/committed-iterated/);
    expect(() => assertActionSupported(v1Caps, 'allocation-batch'))
      .toThrow(/batch settlement factory/);
  });

  it('allows iterated and batch on V2 even when the asset also supports V1', () => {
    expect(() => assertActionSupported(dualCaps, 'allocation-iterated')).not.toThrow();
    expect(() => assertActionSupported(dualCaps, 'allocation-batch')).not.toThrow();
  });
});

describe('registry — V1-only assets', () => {
  function makeAsset(overrides: Partial<AssetConfig> = {}): AssetConfig {
    return {
      key: 'cc',
      displayName: 'Canton Coin',
      adminParty: 'CCAdmin::1220',
      instrumentIdV2: { admin: 'CCAdmin::1220', id: 'Amulet' },
      scanEndpointUrl: 'https://scan.example/api/scan',
      walletGatewayUrl: 'https://wallet.example/api/v0/dapp',
      allocationsV2: false,
      allocationsV1: true,
      transferEventsV2: false,
      ...overrides,
    } as AssetConfig;
  }

  it('accepts a V1-only asset', () => {
    const registry = loadAssetRegistry({
      version: '0.0.1',
      assets: { cc: makeAsset() },
    });
    expect(registry.requireAsset('cc').allocationsV1).toBe(true);
  });

  it('rejects an asset supporting neither lane', () => {
    expect(() => loadAssetRegistry({
      version: '0.0.1',
      assets: { broken: makeAsset({ key: 'broken', allocationsV1: false }) },
    })).toThrow(/allocationsV2 = true \(preferred\) or allocationsV1 = true/);
  });
});
