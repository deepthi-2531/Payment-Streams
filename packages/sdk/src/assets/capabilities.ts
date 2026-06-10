/**
 * @module assets/capabilities
 *
 * Capability resolution for the V2 (preferred) and V1 (transitional)
 * settlement lanes.
 *
 * V2 is the primary lane: per CIP-0112 §5 V2 backwards compatibility,
 * V1 assets are expected to publish V2 interfaces alongside V1, and
 * once an asset advertises V2 in `supportedApis` the library routes V2.
 *
 * The V1 lane (`allocationsV1`) exists so assets that are live on
 * MainNet today but have not yet published V2 (Canton Coin / Amulet,
 * USDCx) can settle via `splice-api-token-allocation-v1`. V1 lacks
 * committed-iterated allocations and batch settlement, so those actions
 * remain V2-only; recurring streams on V1 run one allocation cycle per
 * withdrawal. The V1 lane is deprecated from birth and is removed once
 * the reference assets advertise V2.
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

/** Settlement API generation a dispatch can route against. */
export type SettlementApiVersion = 'v1' | 'v2';

/**
 * Resolved capabilities for a single asset.
 */
export interface AssetCapabilities {
  readonly key: string;
  /**
   * Asset supports V2 allocation features (multi-leg, batch settlement,
   * committed + iterated allocations). Preferred lane whenever `true`.
   */
  readonly allocationsV2: boolean;
  /**
   * Asset supports CIP-56 V1 allocations (`splice-api-token-allocation-v1`).
   * Transitional lane for assets live on MainNet that have not yet
   * published V2 interfaces. Iterated and batch actions are not
   * available on this lane.
   */
  readonly allocationsV1: boolean;
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
    allocationsV1: asset.allocationsV1 === true,
    transferEventsV2: asset.transferEventsV2,
    paused: asset.paused === true,
    ...(asset.pauseInfo !== undefined ? { pauseInfo: asset.pauseInfo } : {}),
    source: 'registry',
  };
}

/**
 * Resolve which settlement API generation to route for an asset.
 *
 *   - With no `prefer`: V2 when available, else V1.
 *   - With `prefer`: validates the asset actually supports that lane
 *     (so a caller pinning `'v1'` against a V2-only asset fails loudly
 *     instead of emitting the wrong vocabulary).
 *
 * Throws if the asset supports neither lane — the registry validates
 * this at load time, so hitting it indicates a hand-built caps object.
 */
export function resolveSettlementVersion(
  caps: AssetCapabilities,
  prefer?: SettlementApiVersion,
): SettlementApiVersion {
  if (prefer === 'v2') {
    if (!caps.allocationsV2) {
      throw new Error(
        `Asset "${caps.key}" does not support V2 allocations; cannot route the requested 'v2' lane.`,
      );
    }
    return 'v2';
  }
  if (prefer === 'v1') {
    if (!caps.allocationsV1) {
      throw new Error(
        `Asset "${caps.key}" does not support V1 allocations; cannot route the requested 'v1' lane.`,
      );
    }
    return 'v1';
  }
  if (caps.allocationsV2) return 'v2';
  if (caps.allocationsV1) return 'v1';
  throw new Error(
    `Asset "${caps.key}" supports neither V2 nor V1 allocations; it should have been rejected at registry load.`,
  );
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
 * Assert that the given action is supported by the asset's capabilities
 * on the resolved settlement lane. Throws with a descriptive message if
 * not. Also throws `PausedInstrumentError` if the asset is paused.
 *
 * Rules:
 *   - Any action is blocked if `paused = true`
 *   - Without an explicit `version`, the lane is resolved via
 *     {@link resolveSettlementVersion} (V2 preferred)
 *   - `allocation-iterated` and `allocation-batch` are V2-only —
 *     V1 has no committed-iterated allocation and no batch factory
 *   - `event-subscription` requires `transferEventsV2` on either lane
 */
export function assertActionSupported(
  caps: AssetCapabilities,
  action: StreamAction,
  version?: SettlementApiVersion,
): void {
  if (caps.paused) {
    throw new PausedInstrumentError(caps.key, caps.pauseInfo);
  }
  const lane = resolveSettlementVersion(caps, version);
  if (lane === 'v1' && (action === 'allocation-iterated' || action === 'allocation-batch')) {
    throw new Error(
      `Asset "${caps.key}" routes the V1 settlement lane, which has no ${
        action === 'allocation-iterated' ? 'committed-iterated allocations' : 'batch settlement factory'
      }; ${action} requires CIP-56 V2. ` +
      `On V1, run one allocation cycle per withdrawal instead.`,
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
