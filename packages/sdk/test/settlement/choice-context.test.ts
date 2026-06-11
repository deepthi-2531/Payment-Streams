/**
 * Unit tests for settlement/choice-context.ts — registry choice-context
 * fetcher for the transitional V1 lane. Deleted together with the lane.
 *
 * Covers:
 *   - fetchAllocationChoiceContext URL construction + body mapping
 *   - choiceContextData wrapper (`{values}`) vs bare-map acceptance
 *   - disclosed-contract mapping (camelCase + snake_case)
 *   - nested `choiceContext` response envelope
 *   - fetchAllocationFactory factoryId + context mapping
 *   - RegistryApiError on non-2xx
 *   - end-to-end: fetched context threads disclosures into the transport
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  fetchAllocationChoiceContext,
  fetchAllocationFactory,
  RegistryApiError,
} from '../../src/settlement/choice-context.js';
import { buildAllocationExecuteTransferV1 } from '../../src/commands/allocation-v1.js';
import type { AssetCapabilities } from '../../src/assets/capabilities.js';
import type { Transport, TemplateId } from '../../src/transport/base.js';

const v1Caps: AssetCapabilities = {
  key: 'cc',
  allocationsV2: false,
  allocationsV1: true,
  transferEventsV2: false,
  paused: false,
  source: 'registry',
};

const TEMPLATE_V1: TemplateId = { packageId: 'p1', moduleName: 'M', entityName: 'Alloc' };

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAllocationChoiceContext', () => {
  it('POSTs to the standard choice-context path and maps the response', async () => {
    const fetchFn = mockFetch(200, {
      choiceContextData: {
        values: { 'amulet-rules': { contractId: 'rules-cid' } },
      },
      disclosedContracts: [{
        templateId: 'pkg1:Splice.AmuletRules:AmuletRules',
        contractId: 'rules-cid',
        createdEventBlob: 'YmxvYg==',
        synchronizerId: 'global-domain::1220',
      }],
    });

    const ctx = await fetchAllocationChoiceContext({
      registryApiUrl: 'https://scan.example/api/scan/',
      allocationId: 'alloc-cid-1',
      action: 'execute-transfer',
      token: 'jwt-token',
    });

    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(
      'https://scan.example/api/scan/registry/allocations/v1/alloc-cid-1/choice-contexts/execute-transfer',
    );
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt-token');

    expect(ctx.values).toEqual({ 'amulet-rules': { contractId: 'rules-cid' } });
    expect(ctx.disclosedContracts).toEqual([{
      templateId: 'pkg1:Splice.AmuletRules:AmuletRules',
      contractId: 'rules-cid',
      createdEventBlob: 'YmxvYg==',
      synchronizerId: 'global-domain::1220',
    }]);
  });

  it('accepts a bare values map and snake_case disclosed contracts', async () => {
    mockFetch(200, {
      choice_context_data: { 'open-round': { contractId: 'round-cid' } },
      disclosed_contracts: [{
        template_id: 'pkg1:Splice.Round:OpenMiningRound',
        contract_id: 'round-cid',
        created_event_blob: 'YmxvYg==',
      }],
    });
    const ctx = await fetchAllocationChoiceContext({
      registryApiUrl: 'https://scan.example',
      allocationId: 'a',
      action: 'cancel',
    });
    expect(ctx.values).toEqual({ 'open-round': { contractId: 'round-cid' } });
    expect(ctx.disclosedContracts![0]!.contractId).toBe('round-cid');
    expect(ctx.disclosedContracts![0]!.synchronizerId).toBeUndefined();
  });

  it('unwraps a nested choiceContext envelope', async () => {
    mockFetch(200, {
      choiceContext: {
        choiceContextData: { values: { k: { text: 'v' } } },
        disclosedContracts: [],
      },
    });
    const ctx = await fetchAllocationChoiceContext({
      registryApiUrl: 'https://scan.example',
      allocationId: 'a',
      action: 'withdraw',
    });
    expect(ctx.values).toEqual({ k: { text: 'v' } });
  });

  it('throws RegistryApiError on non-2xx', async () => {
    mockFetch(404, { error: 'allocation not found' });
    await expect(fetchAllocationChoiceContext({
      registryApiUrl: 'https://scan.example',
      allocationId: 'missing',
      action: 'execute-transfer',
    })).rejects.toBeInstanceOf(RegistryApiError);
  });
});

describe('fetchAllocationFactory', () => {
  it('returns factoryId + mapped choice context', async () => {
    const fetchFn = mockFetch(200, {
      factoryId: 'factory-cid-1',
      choiceContext: {
        choiceContextData: { values: { fees: { numeric: '1.0' } } },
        disclosedContracts: [{
          templateId: 'pkg1:Splice.AmuletRules:AmuletRules',
          contractId: 'rules-cid',
          createdEventBlob: 'YmxvYg==',
        }],
      },
    });
    const result = await fetchAllocationFactory('https://scan.example', {
      choiceArguments: { expectedAdmin: 'DSO::1220' },
    });
    const [url] = fetchFn.mock.calls[0]! as [string];
    expect(url).toBe('https://scan.example/registry/allocation-instruction/v1/allocation-factory');
    expect(result.factoryId).toBe('factory-cid-1');
    expect(result.choiceContext.disclosedContracts).toHaveLength(1);
  });

  it('throws when factoryId is missing', async () => {
    mockFetch(200, { choiceContext: {} });
    await expect(fetchAllocationFactory('https://scan.example', { choiceArguments: {} }))
      .rejects.toThrow(/missing factoryId/);
  });
});

describe('context → transport threading', () => {
  it('passes fetched disclosures through to transport.exercise', async () => {
    mockFetch(200, {
      choiceContextData: { values: { 'amulet-rules': { contractId: 'rules-cid' } } },
      disclosedContracts: [{
        templateId: 'pkg1:Splice.AmuletRules:AmuletRules',
        contractId: 'rules-cid',
        createdEventBlob: 'YmxvYg==',
      }],
    });
    const ctx = await fetchAllocationChoiceContext({
      registryApiUrl: 'https://scan.example',
      allocationId: 'alloc-1',
      action: 'execute-transfer',
    });

    const transport = {
      create: vi.fn(),
      exercise: vi.fn().mockResolvedValue({}),
      exerciseByKey: vi.fn(),
      query: vi.fn(),
    } as unknown as Transport;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

    await buildAllocationExecuteTransferV1(
      transport, v1Caps, 'alloc-1', TEMPLATE_V1, ['Op::1'], logger, { context: ctx },
    );

    const call = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // arg index 5 = readAs (undefined), 6 = CommandOptions with disclosures
    expect(call[5]).toBeUndefined();
    expect(call[6]).toEqual({
      disclosedContracts: [{
        templateId: 'pkg1:Splice.AmuletRules:AmuletRules',
        contractId: 'rules-cid',
        createdEventBlob: 'YmxvYg==',
      }],
    });
    // context values also land in extraArgs
    const arg = call[3] as {
      extraArgs: { context: { values: { text_map: { entries: Array<{ key: string }> } } } };
    };
    expect(arg.extraArgs.context.values.text_map.entries[0]!.key).toBe('amulet-rules');
  });
});
