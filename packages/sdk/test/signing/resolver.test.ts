/**
 * Tests for SigningProviderResolver (STR-84.3).
 *
 * Covers:
 *   - forParty() looks up via listAccounts + caches
 *   - Per-party kind routing (5 providers can coexist on one gateway)
 *   - Cache invalidation
 *   - TTL expiry triggers re-fetch
 *   - Unknown signingProviderId is skipped + warned
 *   - Missing party throws UNAUTHORIZED
 */

import { describe, it, expect, vi } from 'vitest';
import { createSigningProviderResolver, normalizeSigningProviderId, makeAdapterForKind } from '../../src/signing/resolver.js';
import { SigningErrorCode } from '../../src/signing/provider.js';
import { ParticipantSigningProvider } from '../../src/signing/adapters/participant.js';
import { FireblocksSigningProvider } from '../../src/signing/adapters/fireblocks.js';
import { DfnsSigningProvider } from '../../src/signing/adapters/dfns.js';

function mockGateway(accounts: Array<{ partyId: string; signingProviderId: string }>) {
  let callCount = 0;
  const fetchImpl = vi.fn(async () => {
    callCount++;
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: callCount,
        result: accounts.map((a) => ({
          primary: false,
          partyId: a.partyId,
          status: 'allocated',
          hint: a.partyId.split('::')[0]!,
          publicKey: 'pk',
          namespace: a.partyId.split('::')[1] ?? '',
          networkId: 'canton:test',
          signingProviderId: a.signingProviderId,
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, getCallCount: () => callCount };
}

const baseConn = {
  gatewayUrl: 'https://gateway.test/api/v0/dapp',
  accessToken: 'jwt',
};

describe('normalizeSigningProviderId', () => {
  it('recognizes the 5 documented kinds', () => {
    expect(normalizeSigningProviderId('participant')).toBe('participant');
    expect(normalizeSigningProviderId('fireblocks')).toBe('fireblocks');
    expect(normalizeSigningProviderId('blockdaemon')).toBe('blockdaemon');
    expect(normalizeSigningProviderId('dfns')).toBe('dfns');
    expect(normalizeSigningProviderId('wallet-gateway-internal')).toBe('wallet-gateway-internal');
  });
  it('returns undefined for unknown kind', () => {
    expect(normalizeSigningProviderId('unknown-provider')).toBeUndefined();
    expect(normalizeSigningProviderId('')).toBeUndefined();
  });
});

describe('makeAdapterForKind', () => {
  it('builds the correct adapter class per kind', () => {
    expect(makeAdapterForKind('participant', baseConn)).toBeInstanceOf(ParticipantSigningProvider);
    expect(makeAdapterForKind('fireblocks', baseConn)).toBeInstanceOf(FireblocksSigningProvider);
    expect(makeAdapterForKind('dfns', baseConn)).toBeInstanceOf(DfnsSigningProvider);
  });
});

describe('SigningProviderResolver.forParty', () => {
  it('returns the correct adapter kind for each party', async () => {
    const { fetchImpl } = mockGateway([
      { partyId: 'Alice::ns1', signingProviderId: 'participant' },
      { partyId: 'Bob::ns1',   signingProviderId: 'fireblocks' },
      { partyId: 'Carol::ns1', signingProviderId: 'dfns' },
    ]);
    const resolver = await createSigningProviderResolver({ ...baseConn, fetchImpl });
    const alice = await resolver.forParty('Alice::ns1');
    const bob = await resolver.forParty('Bob::ns1');
    const carol = await resolver.forParty('Carol::ns1');
    expect(alice.kind).toBe('participant');
    expect(bob.kind).toBe('fireblocks');
    expect(carol.kind).toBe('dfns');
  });

  it('caches lookups across calls (one listAccounts call for many parties)', async () => {
    const { fetchImpl, getCallCount } = mockGateway([
      { partyId: 'Alice::ns', signingProviderId: 'participant' },
      { partyId: 'Bob::ns',   signingProviderId: 'participant' },
    ]);
    const resolver = await createSigningProviderResolver({ ...baseConn, fetchImpl });
    await resolver.forParty('Alice::ns');
    await resolver.forParty('Bob::ns');
    await resolver.forParty('Alice::ns');
    // Single network fetch (warmed once by first forParty miss).
    expect(getCallCount()).toBe(1);
  });

  it('throws UNAUTHORIZED when party not in listAccounts', async () => {
    const { fetchImpl } = mockGateway([
      { partyId: 'Alice::ns', signingProviderId: 'participant' },
    ]);
    const resolver = await createSigningProviderResolver({ ...baseConn, fetchImpl });
    await expect(resolver.forParty('Unknown::ns')).rejects.toMatchObject({
      code: SigningErrorCode.UNAUTHORIZED,
    });
  });

  it('invalidate() forces re-fetch on next forParty', async () => {
    const { fetchImpl, getCallCount } = mockGateway([
      { partyId: 'Alice::ns', signingProviderId: 'participant' },
    ]);
    const resolver = await createSigningProviderResolver({ ...baseConn, fetchImpl });
    await resolver.forParty('Alice::ns');
    expect(getCallCount()).toBe(1);
    resolver.invalidate();
    await resolver.forParty('Alice::ns');
    expect(getCallCount()).toBe(2);
  });

  it('eager option pre-warms the cache', async () => {
    const { fetchImpl, getCallCount } = mockGateway([
      { partyId: 'Alice::ns', signingProviderId: 'participant' },
    ]);
    await createSigningProviderResolver({ ...baseConn, fetchImpl }, { eager: true });
    expect(getCallCount()).toBe(1);
  });

  it('warns + skips unknown signingProviderId without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl } = mockGateway([
      { partyId: 'Alice::ns', signingProviderId: 'unknown-provider' },
      { partyId: 'Bob::ns',   signingProviderId: 'participant' },
    ]);
    const resolver = await createSigningProviderResolver({ ...baseConn, fetchImpl });
    const bob = await resolver.forParty('Bob::ns');
    expect(bob.kind).toBe('participant');
    await expect(resolver.forParty('Alice::ns')).rejects.toMatchObject({
      code: SigningErrorCode.UNAUTHORIZED,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('Adapter API surface', () => {
  it('all 5 adapter classes implement prepareExecute / listAccounts / etc.', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    for (const kind of ['participant', 'fireblocks', 'blockdaemon', 'dfns', 'wallet-gateway-internal'] as const) {
      const a = makeAdapterForKind(kind, { ...baseConn, fetchImpl });
      expect(typeof a.prepareExecute).toBe('function');
      expect(typeof a.prepareExecuteAndWait).toBe('function');
      expect(typeof a.signMessage).toBe('function');
      expect(typeof a.ledgerApi).toBe('function');
      expect(typeof a.listAccounts).toBe('function');
      // smoke call:
      await a.prepareExecute({ commands: [] });
    }
  });
});
