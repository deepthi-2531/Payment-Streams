/**
 * @module assets/capabilities
 *
 * V2-only capability resolution.
 *
 * Per CIP-0112 §5 V2 backwards compatibility, V1 assets are expected to
 * publish V2 interfaces alongside V1; our library integrates with assets
 * once they advertise V2 in `supportedApis`. V1-only assets are not
 * supported because the streaming primitive requires V2 iterated
 * allocations.
 *
 * This module centralizes capability resolution so dApps and the
 * library never branch by asset name — they branch by capability.
 *
 * Capability resolution:
 *
 *   1. Static (from `AssetRegistry`): `allocationsV2` / `transferEventsV2` /
 *      `paused` flags declared in the registry.
 *   2. Dynamic (queries asset admin metadata on-chain via the registry's
 *      metadata API): optional refresh that confirms / corrects the
 *      static flags. Cached per asset for the SDK session.
 */

import type { AssetConfig, AssetRegistry, InstrumentIdV2 } from './registry.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Resolved capabilities for a single V2 asset.
 */
export interface AssetCapabilities {
  readonly key: string;
  /**
   * Asset supports V2 allocation features (multi-leg, batch settlement,
   * committed + iterated allocations). Always `true` for a V2-only
   * registry; kept as a field so call-sites can read it explicitly.
   */
  readonly allocationsV2: boolean;
  /** Asset supports V2 TransferEvents (event-driven advancement). */
  readonly transferEventsV2: boolean;
  /**
   * Pause state surfaced from V2 metadata API. When `true`, dispatch
   * fails-fast with PausedInstrumentError.
   */
  readonly paused: boolean;
  readonly pauseInfo?: string;
  /** Source of truth for these flags. */
  readonly source: 'registry' | 'on-chain';
}

/**
 * Action categories the SDK might dispatch on. Used in
 * {@link assertActionSupported} to gate operations that require specific
 * V2 sub-features (e.g. event subscriptions require `transferEventsV2`).
 */
export type StreamAction =
  | 'transfer'
  | 'allocation-single-leg'
  | 'allocation-multi-leg'
  | 'allocation-batch'
  | 'allocation-iterated'
  | 'event-subscription';

// ---------------------------------------------------------------------------
// Capability resolution
// ---------------------------------------------------------------------------

/**
 * Resolve capabilities from the registry (static, no I/O).
 */
export function getAssetCapabilitiesFromRegistry(
  asset: AssetConfig,
): AssetCapabilities {
  return {
    key: asset.key,
    allocationsV2: asset.allocationsV2,
    transferEventsV2: asset.transferEventsV2,
    paused: asset.paused === true,
    ...(asset.pauseInfo !== undefined ? { pauseInfo: asset.pauseInfo } : {}),
    source: 'registry',
  };
}

/**
 * Look up an asset and resolve its capabilities in one step. Throws
 * if the asset is not in the registry.
 */
export function getAssetCapabilities(
  registry: AssetRegistry,
  refOrKey: InstrumentIdV2 | string,
): AssetCapabilities {
  const asset = registry.requireAsset(refOrKey);
  return getAssetCapabilitiesFromRegistry(asset);
}

/**
 * Async on-chain capability refresh. Queries the asset admin's
 * metadata to confirm which interfaces are actually published, then
 * returns a refreshed capabilities record.
 *
 * Use this when the registry might be stale (e.g. immediately after
 * an asset publishes V2 per CIP-0112 §5), or for verification before
 * pinning a long-running settlement.
 *
 * The actual metadata-query implementation is deferred to the
 * `MetadataFetcher` callback so this module stays transport-agnostic.
 */
export type MetadataFetcher = (
  asset: AssetConfig,
) => Promise<Partial<AssetCapabilities>>;

export class CapabilityCache {
  private readonly cache = new Map<string, AssetCapabilities>();

  constructor(
    private readonly registry: AssetRegistry,
    private readonly fetcher?: MetadataFetcher,
  ) {}

  /** Synchronous (registry-only) capability lookup, cached. */
  get(refOrKey: InstrumentIdV2 | string): AssetCapabilities {
    const asset = this.registry.requireAsset(refOrKey);
    const cached = this.cache.get(asset.key);
    if (cached) return cached;
    const caps = getAssetCapabilitiesFromRegistry(asset);
    this.cache.set(asset.key, caps);
    return caps;
  }

  /**
   * Refresh from on-chain metadata. Returns the refreshed capabilities
   * and updates the cache. Falls back to static registry if no fetcher
   * was configured.
   */
  async refresh(refOrKey: InstrumentIdV2 | string): Promise<AssetCapabilities> {
    const asset = this.registry.requireAsset(refOrKey);
    const baseline = getAssetCapabilitiesFromRegistry(asset);
    if (!this.fetcher) {
      this.cache.set(asset.key, baseline);
      return baseline;
    }
    const overrides = await this.fetcher(asset);
    const refreshed: AssetCapabilities = {
      ...baseline,
      ...overrides,
      key: asset.key,
      source: 'on-chain',
    };
    this.cache.set(asset.key, refreshed);
    return refreshed;
  }

  /** Force-clear the cache. */
  clear(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Action gating (V2 sub-features)
// ---------------------------------------------------------------------------

/**
 * Error thrown when an instrument is paused per V2 metadata.
 */
export class PausedInstrumentError extends Error {
  constructor(public readonly assetKey: string, public readonly pauseInfo?: string) {
    super(
      `Instrument "${assetKey}" is paused${pauseInfo ? `: ${pauseInfo}` : ''}. ` +
      `Per CIP-0112 metadata, the registry has signaled this asset cannot be transacted right now.`,
    );
    this.name = 'PausedInstrumentError';
  }
}

/**
 * Assert that the given action is supported by the asset's V2 capabilities.
 * Throws with a descriptive message if not. Also throws `PausedInstrumentError`
 * if the asset is paused.
 *
 * Rules (V2-only):
 *   - All actions require `allocationsV2` (enforced at registry-load time)
 *   - `event-subscription` additionally requires `transferEventsV2`
 *   - Any action is blocked if `paused = true`
 */
export function assertActionSupported(
  caps: AssetCapabilities,
  action: StreamAction,
): void {
  if (caps.paused) {
    throw new PausedInstrumentError(caps.key, caps.pauseInfo);
  }
  if (!caps.allocationsV2) {
    // Should never trigger — the registry validates this at load time.
    // Defense in depth in case a test fixture constructs a bad caps object.
    throw new Error(
      `Asset "${caps.key}" does not support V2 allocations; ${action} requires CIP-56 V2.`,
    );
  }
  if (action === 'event-subscription' && !caps.transferEventsV2) {
    throw new Error(
      `Asset "${caps.key}" does not support TransferEventsV2; cannot subscribe to event-driven advancement.`,
    );
  }
}

/**
 * Convenience: resolve + assert in one call from a registry lookup.
 */
export function assertActionForAsset(
  registry: AssetRegistry,
  refOrKey: InstrumentIdV2 | string,
  action: StreamAction,
): AssetCapabilities {
  const caps = getAssetCapabilities(registry, refOrKey);
  assertActionSupported(caps, action);
  return caps;
}
