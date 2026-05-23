# Per-Asset Configuration (V2-only)

How to configure Canton Payment Streams to work with a specific
Token-Standard-V2 asset.

> **Status (V2-only per [STR-79](https://linear.app/bitdynamics/issue/STR-79))**:
> this library only supports assets that advertise CIP-56 V2 interfaces
> in their `supportedApis` metadata field. Per
> [CIP-0112 §5](https://github.com/canton-foundation/cips/blob/main/cip-0112/cip-0112.md#5-backwards-compatibility),
> V1 assets are expected to publish V2 alongside V1; once your asset
> advertises V2, register it here. V1-only assets cannot stream with this
> library — V1 has no iterated-allocation primitive that the streaming
> model requires.

---

## The asset registry

The canonical per-asset configuration lives in
`config/asset-registry.json`. The shape is documented at the top of
`packages/sdk/src/assets/registry.ts`.

For each asset, you supply:

| Field | What it is | Where to get it |
|---|---|---|
| `key` | Stable identifier ("cc", "usdcx", "my-asset") | You choose |
| `displayName` | Human-readable | You choose |
| `instrumentIdV2` | V2 2-field record `{ admin, id }` | From the asset admin's V2 metadata |
| `adminParty` | Party id of the registry app administering the asset | From the SV listing |
| `scanEndpointUrl` | SV Scan endpoint URL | From the SV listing |
| `walletGatewayUrl` | Wallet-gateway base URL (JSON-RPC dApp API) | From the SV listing or the asset admin |
| `allocationsV2` | true if V2 allocations are supported (required true) | From asset admin metadata |
| `transferEventsV2` | true if V2 TransferEvents are supported | From asset admin metadata |
| `paused` | true if V2 metadata signals the instrument is paused | From asset admin metadata (STR-96) |
| `pauseInfo` | Optional explanation for paused state | From asset admin metadata |

---

## Generating the registry

For programmatic generation:

```
node scripts/build-asset-registry.mjs --network mainnet --out config/asset-registry.json
```

This consumes `scripts/asset-registry-seeds.json` (which you edit to pin
per-asset display names + V2 capability flags) and merges with the SV
status to produce the final registry. Assets without `allocationsV2 =
true` are skipped with a clear log message.

For one-off / custom assets not in the SV listing, edit
`config/asset-registry.json` directly.

---

## Picking an asset in your dApp

```ts
import { loadAssetRegistry } from '@canton-streams/sdk';

const registry = loadAssetRegistry(assetRegistryFile);

// By key (most common):
const myAsset = registry.requireAsset('my-asset');

// By V2 InstrumentIdV2:
const v2Asset = registry.getAssetByV2Id({ admin: '...', id: '...' });

// List all available:
for (const asset of registry.listAssets()) {
  console.log(asset.key, asset.displayName);
}
```

---

## Capability checks

The library asserts V2 capabilities + pause state at dispatch time:

```ts
import {
  getAssetCapabilities,
  assertActionSupported,
  PausedInstrumentError,
} from '@canton-streams/sdk';

const caps = getAssetCapabilities(registry, 'my-asset');
console.log(caps);
// {
//   key: 'my-asset',
//   allocationsV2: true,
//   transferEventsV2: true,
//   paused: false,
//   source: 'registry',
// }

try {
  assertActionSupported(caps, 'allocation-iterated');
} catch (err) {
  if (err instanceof PausedInstrumentError) {
    // Asset is paused — surface to user, retry later
  }
  throw err;
}
```

`assertActionSupported` throws:

* `PausedInstrumentError` if the asset is paused per V2 metadata
* Generic `Error` if `event-subscription` is requested on an asset without
  `transferEventsV2`

---

## Adding a new asset

1. Confirm the asset advertises V2 in its `supportedApis` metadata field
2. Get the asset's `adminParty`, `scanEndpointUrl`, `walletGatewayUrl`
   from the SV operator + asset admin
3. Look up `instrumentIdV2.admin` (the issuing party) and
   `instrumentIdV2.id` (the asset's opaque V2 identifier) from the asset
   admin metadata
4. Add an entry to `scripts/asset-registry-seeds.json` with
   `allocationsV2: true`
5. Run `node scripts/build-asset-registry.mjs` to regenerate
6. Commit the resulting `config/asset-registry.json`
7. Test with the V2 testnet probe (once `scripts/testnet-v2-stream-probe.mjs`
   ships per [STR-78](https://linear.app/bitdynamics/issue/STR-78))

---

## V1 → V2 transition story (for partners)

If your asset is V1-only today, the path forward is:

1. **Add V2 interfaces to your asset's Daml package** per the
   [CIP-0112 §5 dual-implementation requirement](https://github.com/canton-foundation/cips/blob/main/cip-0112/cip-0112.md#5-backwards-compatibility).
   The compatibility layer in
   [`splice-token-standard-utils`](https://github.com/canton-network/splice/tree/token-standard-v2-upcoming/token-standard/splice-token-standard-utils)
   provides V1↔V2 mapping helpers so existing V1 holdings can be allocated
   via the V2 `AllocationFactory_Allocate` without re-issuance.
2. **Advertise V2 in your metadata**: set `supportedApis` to include the
   V2 package ids. This is the gate our SDK reads.
3. **Add the asset to our registry**: with `allocationsV2: true`,
   `transferEventsV2: true` (if the asset publishes the V2 events
   package).
4. Done — our library integrates automatically.
