/**
 * @module assets/registry
 *
 * Asset registry for the Canton Payment Streams SDK.
 *
 * The registry provides per-asset routing (admin party, Scan endpoint URL,
 * wallet-gateway URL, V2 capability flags) without requiring dApps or the
 * library to branch by asset name. The same code path serves any CIP-56
 * V2 asset; what differs per asset is configuration.
 *
 * The library prefers CIP-56 V2 assets; once an asset advertises V2 in
 * `supportedApis`, set `allocationsV2 = true` and the V2 lane is routed.
 * Assets that are live on MainNet but have not yet published V2
 * (Canton Coin / Amulet, USDCx) may set `allocationsV1 = true` to route
 * the transitional `splice-api-token-allocation-v1` lane instead.
 * Every asset must support at least one of the two lanes.
 *
 * Sources:
 *   - `config/asset-registry.json` (canonical, in-repo)
 *   - Constructor override (tests, custom deployments)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * V2 instrument identifier — admin party + opaque id Text per CIP-56 V2.
 */
export interface InstrumentIdV2 {
  readonly admin: string;
  readonly id: string;
}

/**
 * Per-asset configuration. The shape mirrors `config/asset-registry.json`
 * but uses TypeScript types for safe consumption.
 */
export interface AssetConfig {
  /** Stable key, e.g. "cc", "usdcx", "my-asset". */
  readonly key: string;

  /** Human-readable display name. */
  readonly displayName: string;

  /**
   * Instrument id — `{ admin, id }`. Required for every asset. The V1
   * `Splice.Api.Token.HoldingV1.InstrumentId` has the same shape, so
   * V1-lane assets fill this with their V1 admin + id and the field
   * doubles as the registry lookup key for both lanes.
   */
  readonly instrumentIdV2: InstrumentIdV2;

  /** Registry-app admin party. */
  readonly adminParty: string;

  /**
   * Super Validator Scan endpoint URL for this asset's transaction
   * history. Used by `query-adoption-metrics.mjs` (multi-Scan aggregator)
   * and by SDK consumers that want to read directly.
   */
  readonly scanEndpointUrl: string;

  /**
   * Wallet-gateway base URL for the JSON-RPC dApp API targeting this
   * asset. The wallet gateway is the documented signing surface for
   * command submission.
   */
  readonly walletGatewayUrl: string;

  /**
   * Token-standard registry API base URL (choice contexts, allocation
   * factory). For Amulet this is served by Scan. Optional — consumers
   * fall back to `scanEndpointUrl` when unset.
   */
  readonly tokenStandardApiUrl?: string;

  /**
   * Asset supports V2 allocation features (multi-leg, batch settlement,
   * committed + iterated allocations). Preferred lane whenever `true`.
   */
  readonly allocationsV2: boolean;

  /**
   * Asset supports CIP-56 V1 allocations (`splice-api-token-allocation-v1`).
   * Transitional lane for assets live on MainNet that have not yet
   * published V2 interfaces; deprecated from birth and removed once the
   * reference assets advertise V2. At least one of `allocationsV2` /
   * `allocationsV1` must be `true`.
   */
  readonly allocationsV1?: boolean;

  /**
   * Asset supports V2 TransferEvents (event-driven advancement via
   * `splice-api-token-transfer-events-v2` / `EventLog_HoldingsChange`).
   */
  readonly transferEventsV2: boolean;

  /**
   * Optional pause state surfaced from V2 metadata API. When `paused = true`,
   * the SDK fails-fast with a `PausedInstrumentError` at dispatch time.
   */
  readonly paused?: boolean;
  readonly pauseInfo?: string;

  /** Optional free-form metadata for downstream consumers. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Top-level shape of `config/asset-registry.json`.
 */
export interface AssetRegistryFile {
  readonly version: string;
  readonly buildTime?: string;
  readonly note?: string;
  readonly assets: Readonly<Record<string, AssetConfig>>;
}

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

/**
 * Asset registry. Loaded once at SDK init; can be re-constructed for
 * tests or per-deployment customization.
 *
 * Lookup paths:
 *   - by `key` (stable identifier like "cc" or "usdcx")
 *   - by V2 `InstrumentIdV2` (admin + id)
 */
export class AssetRegistry {
  private readonly assetsByKey: Map<string, AssetConfig>;
  private readonly assetsByV2Id: Map<string, AssetConfig>;

  constructor(public readonly file: AssetRegistryFile) {
    this.assetsByKey = new Map();
    this.assetsByV2Id = new Map();

    for (const [key, asset] of Object.entries(file.assets)) {
      // Defensive: ensure `key` field matches the dictionary key.
      const normalized: AssetConfig = { ...asset, key };
      this.assetsByKey.set(key, normalized);
      this.assetsByV2Id.set(assetV2IdKey(normalized.instrumentIdV2), normalized);
    }
  }

  /** All assets in the registry, in insertion order. */
  listAssets(): AssetConfig[] {
    return Array.from(this.assetsByKey.values());
  }

  /** Look up an asset by its stable key, e.g. "cc". */
  getAssetByKey(key: string): AssetConfig | undefined {
    return this.assetsByKey.get(key);
  }

  /** Look up an asset by V2 InstrumentIdV2. */
  getAssetByV2Id(id: InstrumentIdV2): AssetConfig | undefined {
    return this.assetsByV2Id.get(assetV2IdKey(id));
  }

  /**
   * Unified lookup. Accepts a V2 InstrumentIdV2 or a string key, and
   * resolves to the asset config or undefined.
   */
  getAsset(refOrKey: InstrumentIdV2 | string): AssetConfig | undefined {
    if (typeof refOrKey === 'string') {
      return this.getAssetByKey(refOrKey);
    }
    return this.getAssetByV2Id(refOrKey);
  }

  /**
   * Resolve an asset or throw a descriptive error. Useful at SDK
   * call-sites where the asset must be in the registry.
   */
  requireAsset(refOrKey: InstrumentIdV2 | string): AssetConfig {
    const asset = this.getAsset(refOrKey);
    if (!asset) {
      const ref = typeof refOrKey === 'string' ? refOrKey : JSON.stringify(refOrKey);
      throw new Error(
        `Asset not found in registry: ${ref}. Add it to config/asset-registry.json or pass an override via AssetRegistry constructor. ` +
        `The asset must advertise CIP-56 V2 support (allocationsV2) or, transitionally, V1 support (allocationsV1).`,
      );
    }
    return asset;
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load the asset registry from a JSON payload. Validates required
 * fields and returns a typed registry.
 */
export function loadAssetRegistry(file: AssetRegistryFile): AssetRegistry {
  validateRegistryFile(file);
  return new AssetRegistry(file);
}

/**
 * Validate the registry file structure. Throws on missing required
 * fields with a clear error message.
 */
function validateRegistryFile(file: AssetRegistryFile): void {
  if (!file || typeof file !== 'object') {
    throw new Error('Asset registry must be a non-null object');
  }
  if (typeof file.version !== 'string' || file.version.length === 0) {
    throw new Error('Asset registry requires a non-empty `version`');
  }
  if (!file.assets || typeof file.assets !== 'object') {
    throw new Error('Asset registry requires an `assets` map');
  }
  for (const [key, asset] of Object.entries(file.assets)) {
    if (typeof asset.adminParty !== 'string' || asset.adminParty.length === 0) {
      throw new Error(`Asset "${key}" requires a non-empty adminParty`);
    }
    if (typeof asset.scanEndpointUrl !== 'string' || asset.scanEndpointUrl.length === 0) {
      throw new Error(`Asset "${key}" requires a non-empty scanEndpointUrl`);
    }
    if (typeof asset.walletGatewayUrl !== 'string' || asset.walletGatewayUrl.length === 0) {
      throw new Error(`Asset "${key}" requires a non-empty walletGatewayUrl`);
    }
    if (!asset.instrumentIdV2 || typeof asset.instrumentIdV2 !== 'object') {
      throw new Error(
        `Asset "${key}" requires instrumentIdV2 ({ admin, id }); the V1 InstrumentId has the same shape, ` +
        `so V1-lane assets fill it with their V1 admin + id.`,
      );
    }
    if (typeof asset.instrumentIdV2.admin !== 'string' || asset.instrumentIdV2.admin.length === 0) {
      throw new Error(`Asset "${key}" requires instrumentIdV2.admin`);
    }
    if (typeof asset.instrumentIdV2.id !== 'string') {
      throw new Error(`Asset "${key}" requires instrumentIdV2.id`);
    }
    if (asset.allocationsV2 !== true && asset.allocationsV1 !== true) {
      throw new Error(
        `Asset "${key}" must set allocationsV2 = true (preferred) or allocationsV1 = true (transitional). ` +
        `Per CIP-0112 §5, V1 assets are expected to publish V2 interfaces; once "${key}" advertises ` +
        `V2 in supportedApis, set allocationsV2 = true and drop the V1 flag.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

function assetV2IdKey(id: InstrumentIdV2): string {
  return `${id.admin}|${id.id}`;
}
