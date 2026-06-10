/**
 * Unit tests for assets/capabilities.ts — paused / pauseInfo surfacing
 *
 * Covers:
 *   - getAssetCapabilitiesFromRegistry surfaces paused + pauseInfo
 *   - assertActionSupported throws PausedInstrumentError for paused asset
 *   - CapabilityCache.refresh() picks up paused override from MetadataFetcher
 *   - CapabilityCache caches static results and refresh result independently
 */

import { describe, it, expect, vi } from 'vitest';

import {
  getAssetCapabilitiesFromRegistry,
  getAssetCapabilities,
  assertActionSupported,
  CapabilityCache,
  PausedInstrumentError,
  type MetadataFetcher,
  type AssetCapabilities,
} from '../../src/assets/capabilities.js';
import { loadAssetRegistry, type AssetConfig } from '../../src/assets/registry.js';

function makeAsset(overrides: Partial<AssetConfig> = {}): AssetConfig {
  return {
    key: 'test-asset',
    displayName: 'Test Asset',
    description: 'Synthetic asset for tests',
    network: 'devnet',
    adminParty: 'admin-party',
    instrumentIdV2: { admin: 'admin-party', id: 'TEST' },
    scanEndpointUrl: 'https://scan.example/v0',
    walletGatewayUrl: 'https://wallet.example/api',
    allocationsV2: true,
    transferEventsV2: true,
    paused: false,
    ...overrides,
  } as AssetConfig;
}

function makeRegistry(assets: AssetConfig[]) {
  return loadAssetRegistry({
    version: '0.0.1',
    generatedAt: new Date().toISOString(),
    assets: Object.fromEntries(assets.map((a) => [a.key, a])),
  });
}

describe('getAssetCapabilitiesFromRegistry', () => {
  it('surfaces paused=false + no pauseInfo for normal asset', () => {
    const caps = getAssetCapabilitiesFromRegistry(makeAsset());
    expect(caps.paused).toBe(false);
    expect(caps.pauseInfo).toBeUndefined();
    expect(caps.source).toBe('registry');
  });

  it('surfaces paused=true + pauseInfo when registry advertises pause', () => {
    const caps = getAssetCapabilitiesFromRegistry(
      makeAsset({ paused: true, pauseInfo: 'maintenance window 2026-05-22' }),
    );
    expect(caps.paused).toBe(true);
    expect(caps.pauseInfo).toBe('maintenance window 2026-05-22');
  });

  it('treats missing paused field as false (backwards-compat)', () => {
    // Registry files predating the field default to non-paused.
    const asset = makeAsset();
    delete (asset as { paused?: boolean }).paused;
    const caps = getAssetCapabilitiesFromRegistry(asset as AssetConfig);
    expect(caps.paused).toBe(false);
  });
});

describe('assertActionSupported with paused asset', () => {
  it('throws PausedInstrumentError on transfer when paused', () => {
    const caps = getAssetCapabilitiesFromRegistry(
      makeAsset({ paused: true, pauseInfo: 'asset under registry review' }),
    );
    expect(() => assertActionSupported(caps, 'transfer')).toThrow(PausedInstrumentError);
    try {
      assertActionSupported(caps, 'transfer');
    } catch (err) {
      expect(err).toBeInstanceOf(PausedInstrumentError);
      expect((err as PausedInstrumentError).assetKey).toBe('test-asset');
      expect((err as PausedInstrumentError).pauseInfo).toBe('asset under registry review');
      expect((err as Error).message).toContain('asset under registry review');
    }
  });

  it('throws PausedInstrumentError on every action category when paused', () => {
    const caps = getAssetCapabilitiesFromRegistry(makeAsset({ paused: true }));
    for (const action of [
      'transfer',
      'allocation-single-leg',
      'allocation-multi-leg',
      'allocation-batch',
      'allocation-iterated',
      'event-subscription',
    ] as const) {
      expect(() => assertActionSupported(caps, action)).toThrow(PausedInstrumentError);
    }
  });

  it('does not throw when paused=false (sanity)', () => {
    const caps = getAssetCapabilitiesFromRegistry(makeAsset({ paused: false }));
    expect(() => assertActionSupported(caps, 'transfer')).not.toThrow();
  });
});

describe('CapabilityCache.refresh + MetadataFetcher on-chain refresh', () => {
  it('refresh() picks up paused=true from on-chain fetcher even if registry advertises paused=false', async () => {
    const registry = makeRegistry([makeAsset({ paused: false })]);
    const fetcher: MetadataFetcher = vi.fn(async () =>
      ({ paused: true, pauseInfo: 'on-chain pause' }) satisfies Partial<AssetCapabilities>,
    );
    const cache = new CapabilityCache(registry, fetcher);
    const refreshed = await cache.refresh('test-asset');
    expect(refreshed.paused).toBe(true);
    expect(refreshed.pauseInfo).toBe('on-chain pause');
    expect(refreshed.source).toBe('on-chain');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('falls back to registry baseline when no fetcher is configured', async () => {
    const registry = makeRegistry([makeAsset({ paused: true, pauseInfo: 'static pause' })]);
    const cache = new CapabilityCache(registry);  // no fetcher
    const refreshed = await cache.refresh('test-asset');
    expect(refreshed.paused).toBe(true);
    expect(refreshed.pauseInfo).toBe('static pause');
    expect(refreshed.source).toBe('registry');
  });

  it('subsequent .get() returns the refreshed value from cache', async () => {
    const registry = makeRegistry([makeAsset({ paused: false })]);
    const fetcher: MetadataFetcher = vi.fn(async () =>
      ({ paused: true, pauseInfo: 'on-chain' }) satisfies Partial<AssetCapabilities>,
    );
    const cache = new CapabilityCache(registry, fetcher);
    await cache.refresh('test-asset');
    const cached = cache.get('test-asset');
    expect(cached.paused).toBe(true);
    expect(cached.source).toBe('on-chain');
  });

  it('clear() drops cached results so subsequent get() returns fresh static baseline', async () => {
    const registry = makeRegistry([makeAsset({ paused: false })]);
    const fetcher: MetadataFetcher = vi.fn(async () => ({ paused: true }));
    const cache = new CapabilityCache(registry, fetcher);
    await cache.refresh('test-asset');
    expect(cache.get('test-asset').paused).toBe(true);
    cache.clear();
    expect(cache.get('test-asset').paused).toBe(false);
  });

  it('fails safe to paused when on-chain metadata omits the paused flag', async () => {
    const registry = makeRegistry([makeAsset({ paused: false })]);
    const fetcher: MetadataFetcher = vi.fn(async () => ({ allocationsV2: true }));
    const cache = new CapabilityCache(registry, fetcher);
    const refreshed = await cache.refresh('test-asset');
    expect(refreshed.paused).toBe(true);
  });

  it('fails safe to paused when on-chain paused is a non-boolean value', async () => {
    const registry = makeRegistry([makeAsset({ paused: false })]);
    // A malformed endpoint that returns a truthy string instead of a boolean.
    const fetcher: MetadataFetcher = vi.fn(async () =>
      ({ paused: 'false' as unknown as boolean }),
    );
    const cache = new CapabilityCache(registry, fetcher);
    const refreshed = await cache.refresh('test-asset');
    expect(refreshed.paused).toBe(true);
  });

  it('only un-pauses on a strict boolean false from on-chain metadata', async () => {
    const registry = makeRegistry([makeAsset({ paused: true })]);
    const fetcher: MetadataFetcher = vi.fn(async () => ({ paused: false }));
    const cache = new CapabilityCache(registry, fetcher);
    const refreshed = await cache.refresh('test-asset');
    expect(refreshed.paused).toBe(false);
  });
});

describe('getAssetCapabilities (unified lookup)', () => {
  it('throws descriptive error when asset is not in registry', () => {
    const registry = makeRegistry([makeAsset()]);
    expect(() => getAssetCapabilities(registry, 'unknown-asset')).toThrow(
      /Asset not found in registry/,
    );
  });

  it('resolves by V2 InstrumentIdV2', () => {
    const registry = makeRegistry([makeAsset({ paused: true })]);
    const caps = getAssetCapabilities(registry, {
      admin: 'admin-party',
      id: 'TEST',
    });
    expect(caps.paused).toBe(true);
    expect(caps.key).toBe('test-asset');
  });
});
