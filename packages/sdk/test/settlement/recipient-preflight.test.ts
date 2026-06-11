/**
 * Unit tests for settlement/recipient-preflight.ts.
 *
 * Covers:
 *   - direct / offer / self / unknown transfer kinds and guidance
 *   - request shape (no holdings, probe-only)
 *   - registry error surfacing
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { checkRecipientDeliverability } from '../../src/settlement/recipient-preflight.js';

const BASE_PARAMS = {
  registryApiUrl: 'https://scan.example/',
  expectedAdmin: 'DSO::1220abc',
  sender: 'payer::1',
  receiver: 'client::2',
};

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

afterEach(() => vi.unstubAllGlobals());

describe('checkRecipientDeliverability', () => {
  it('reports deliverable for kind=direct (preapproval exists)', async () => {
    const fetchFn = mockFetch(200, { factoryId: 'f1', transferKind: 'direct' });
    const result = await checkRecipientDeliverability(BASE_PARAMS);
    expect(result.deliverable).toBe(true);
    expect(result.transferKind).toBe('direct');
    expect(result.guidance).toMatch(/hands-free/);

    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://scan.example/registry/transfer-instruction/v1/transfer-factory');
    const body = JSON.parse(String(init.body));
    expect(body.choiceArguments.transfer.inputHoldingCids).toEqual([]);
    expect(body.choiceArguments.transfer.receiver).toBe('client::2');
  });

  it('reports not deliverable with actionable guidance for kind=offer', async () => {
    mockFetch(200, { factoryId: 'f1', transferKind: 'offer' });
    const result = await checkRecipientDeliverability(BASE_PARAMS);
    expect(result.deliverable).toBe(false);
    expect(result.transferKind).toBe('offer');
    expect(result.guidance).toMatch(/TransferPreapproval/);
  });

  it('treats self-transfers as deliverable', async () => {
    mockFetch(200, { transferKind: 'self' });
    const result = await checkRecipientDeliverability(BASE_PARAMS);
    expect(result.deliverable).toBe(true);
  });

  it('flags unknown kinds without claiming deliverability', async () => {
    mockFetch(200, { transferKind: 'something-new' });
    const result = await checkRecipientDeliverability(BASE_PARAMS);
    expect(result.deliverable).toBe(false);
    expect(result.transferKind).toBe('unknown');
  });

  it('surfaces registry errors', async () => {
    mockFetch(404, { error: 'no factory' });
    await expect(checkRecipientDeliverability(BASE_PARAMS)).rejects.toThrow(/registry 404/);
  });
});
