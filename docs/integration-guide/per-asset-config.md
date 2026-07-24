# Per-Asset Configuration

How to configure Canton Payment Streams to work with a specific
Token-Standard asset.

> **Status:** V2 is the preferred lane — assets that advertise CIP-56 V2
> interfaces in their `supportedApis` metadata field route it automatically.
> Assets live on MainNet that have not yet published V2 (Canton Coin /
> Amulet, USDCx) set `allocationsV1: true` and route the transitional V1
> lane (`splice-api-token-allocation-v1`) instead; see
> [V1-LANE-TESTING.md](../V1-LANE-TESTING.md). V1 has no iterated-allocation
> or batch primitive, so those actions stay V2-only and recurring streams on
> V1 run one allocation cycle per withdrawal. Per
> [CIP-0112 §5](https://github.com/canton-foundation/cips/blob/main/cip-0112/cip-0112.md#5-backwards-compatibility),
> V1 assets are expected to publish V2 alongside V1; once an asset
> advertises V2, its registry flags flip with no code change.

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
| `instrumentIdV2` | 2-field record `{ admin, id }`; doubles as the V1 `InstrumentId` for V1-lane assets | From the asset admin's metadata |
| `adminParty` | Party id of the registry app administering the asset | From the SV listing / asset admin |
| `scanEndpointUrl` | SV Scan endpoint URL | From the SV listing |
| `walletGatewayUrl` | Wallet-gateway base URL (JSON-RPC dApp API) | Deployment-specific (your operator's gateway) |
| `tokenStandardApiUrl` | Token-standard registry API base (optional; falls back to `scanEndpointUrl`) | Scan for Amulet; the issuer's registry endpoint otherwise |
| `allocationsV2` | true if V2 allocations are supported (preferred lane) | From asset admin metadata |
| `allocationsV1` | true to route the transitional V1 lane; at least one of `allocationsV2`/`allocationsV1` must be true | From asset admin metadata |
| `transferEventsV2` | true if V2 TransferEvents are supported | From asset admin metadata |
| `paused` | true if V2 metadata signals the instrument is paused | From asset admin metadata |
| `pauseInfo` | Optional explanation for paused state | From asset admin metadata |

### Registered assets

| Key | Lane | Notes |
|---|---|---|
| `cc` (Canton Coin / Amulet) | V1 (transitional) | Instrument id `Amulet`; admin = DSO party (DA-docs reference value, network-specific — confirm via `GET {scan}/api/scan/v0/dso-party-id`, see entry `meta.adminResolution`). Registry API served by Scan. |
| `usdcx` (USDCx) | V1 (transitional) | Instrument id `USDCx`; real per-network issuer admin + registry base URL from Circle xReserve / DA docs (TestNet in fields, MainNet in `meta.mainnet`). Live checklist: [usdcx-field-validation.md](../validation/usdcx-field-validation.md). |
| `v2-test-asset` | V2 | DevNet-only probe asset. |

The `cc`/`usdcx` entries carry the real published instrument ids, admin
parties, and registry/Scan endpoints. The only remaining placeholder is
`walletGatewayUrl` (operator-specific — each operator runs their own
gateway); probe pre-flight warns on it and hard-fails on mainnet until set.
The CC DSO party is a documented reference value; confirm it against your
target network's Scan before a mainnet run.

Point `walletGatewayUrl` at an `https` gateway (loopback hosts excepted) — it
carries the app bearer token and prepared hashes. The proxy rejects a plaintext
`http` wallet-gateway URL (from `CANTON_STREAMS_WALLET_GATEWAY_URL` /
`WALLET_GATEWAY_URL`) at startup; set `PROXY_ALLOW_INSECURE_WALLET_URL=true` to
lift that check on a trusted private network. The SDK signing layer enforces the
same `https` rule but permits `http` only for a loopback host, with no override.

---

## Generating the registry

For programmatic generation:

```
node scripts/build-asset-registry.mjs --network mainnet --out config/asset-registry.json
```

This consumes `scripts/asset-registry-seeds.json` (which you edit to pin
per-asset display names + capability flags) and merges with the SV
status to produce the final registry. Assets with neither `allocationsV2`
nor `allocationsV1` set to true are skipped with a clear log message.

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
//   allocationsV1: false,
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
* Generic `Error` if `allocation-iterated` / `allocation-batch` is
  requested on an asset that routes the V1 lane
* Generic `Error` if `event-subscription` is requested on an asset without
  `transferEventsV2`

---

## Adding a new asset

1. Confirm which lane the asset supports: V2 advertised in its
   `supportedApis` metadata field (preferred), or the V1 token standard
   (transitional)
2. Get the asset's `adminParty`, `scanEndpointUrl`, `walletGatewayUrl`
   (and `tokenStandardApiUrl` if the registry API is not Scan)
   from the SV operator + asset admin
3. Look up `instrumentIdV2.admin` (the issuing party) and
   `instrumentIdV2.id` (the asset's opaque identifier) from the asset
   admin metadata
4. Add an entry to `scripts/asset-registry-seeds.json` with
   `allocationsV2: true` (or `allocationsV1: true` for V1-lane assets)
5. Run `node scripts/build-asset-registry.mjs` to regenerate
6. Commit the resulting `config/asset-registry.json`
7. Test with the matching testnet probe when you have a live participant
   and wallet gateway (`--asset-key <key>` resolves routing from the
   registry)

---

## V1 → V2 transition story (for asset issuers)

If your asset is V1-only today, register it with `allocationsV1: true`
(streams settle one allocation cycle per withdrawal; iterated/batch
actions stay V2-only). The path to the full feature set is:

1. **Add V2 interfaces to your asset's Daml package** per the
   [CIP-0112 §5 dual-implementation requirement](https://github.com/canton-foundation/cips/blob/main/cip-0112/cip-0112.md#5-backwards-compatibility).
   The compatibility layer in
   [`splice-token-standard-utils`](https://github.com/canton-network/splice/tree/main/token-standard/splice-token-standard-utils)
   provides V1↔V2 mapping helpers so existing V1 holdings can be allocated
   via the V2 `AllocationFactory_Allocate` without re-issuance.
2. **Advertise V2 in your metadata**: set `supportedApis` to include the
   V2 package ids. This is the gate the SDK reads.
3. **Add the asset to the registry**: with `allocationsV2: true`,
   `transferEventsV2: true` (if the asset publishes the V2 events
   package).
4. Done — the library integrates automatically.

---

## Streaming a non-CC asset at the proxy

The registry above is the SDK-side asset catalogue. The **proxy** carries its
own, narrower whitelist for the V1 transfer-instruction lane
(`POST /api/v1/streams`): the assets it will actually create and settle a stream
against. That whitelist is resolved from the proxy's environment at runtime by
`getSupportedAssets()` (`packages/proxy/src/assets.ts`) and surfaced at
`GET /api/assets`.

Two asset slots are wired:

* **Canton Coin** (`key: cc`) — the default. Streamable as soon as
  `CC_ADMIN_PARTY` (or `CANTON_CC_ADMIN`) is set. CC's transfer-instruction
  factory is served by its own Scan, so it reuses the proxy's global
  `REGISTRY_API_URL` and needs no per-asset registry base.
* **USDCx** (`key: usdcx`) — the reference non-CC slot. Streamable only once
  **both** its registrar admin and its **own** registry base are configured.

### Configuring a non-CC asset

Set the per-asset environment before starting the proxy:

| Env var | Required | Default | What it is |
|---|---|---|---|
| `USDCX_ADMIN_PARTY` | yes | — | Party id of the asset's registrar / issuer (the instrument admin) |
| `USDCX_REGISTRY_API_URL` | yes | — | Base URL of this asset's transfer-instruction registry (distinct from CC's Scan) |
| `USDCX_HOLDING_TEMPLATE_ID` | no | (empty) | Concrete holding template the asset is funded from / verified against |
| `USDCX_INSTRUMENT_ID` | no | `USDCx` | Instrument id under that admin |
| `USDCX_TRANSFER_VERSION` | no | `v1` | Token-standard transfer API version (`v1` / `v2`) |
| `USDCX_DECIMALS` | no | `6` | Display decimals |

Both `USDCX_ADMIN_PARTY` **and** `USDCX_REGISTRY_API_URL` must be present, or the
asset is omitted from the whitelist entirely — a stream is never created against
an unroutable instrument. A party id left as a `TBD` placeholder counts as unset.

> There is no standardized admin → registry discovery: the registry base URL is
> configured out-of-band, per asset. You get it from the asset's issuer, not by
> querying the admin party.

Example (placeholders — substitute your network's real values):

```bash
USDCX_ADMIN_PARTY=<usdcx-registrar-party>
USDCX_REGISTRY_API_URL=https://<usdcx-registry-host>
USDCX_HOLDING_TEMPLATE_ID=<package-id>:<Module>:<Template>
USDCX_TRANSFER_VERSION=v1
USDCX_DECIMALS=6
```

### Creating a stream against it

1. Confirm the asset is whitelisted — it appears in the `GET /api/assets`
   array under the `key` you'll use:

   ```bash
   curl -s "$PROXY_URL/api/assets" | jq '.[].key'
   # "cc"
   # "usdcx"
   ```

2. Create with `assetKey` in the `POST /api/v1/streams` body:

   ```jsonc
   { "streamId": "...", "recipientParty": "...", "assetKey": "usdcx" /* ... */ }
   ```

* `assetKey` **absent** or `"cc"` ⇒ Canton Coin (CC streams settle exactly as
  before; no per-stream instrument is stored).
* An **unknown or unconfigured** `assetKey` ⇒ `400 { "reason": "unknown_asset" }`.

The chosen instrument — admin, instrument id, registry base, holding template,
transfer version — is **frozen onto the stream at create time**. Every later
settle and on-chain-verify for that stream reads the frozen instrument, so
registry drift or an env change can't retarget a live stream.

### Settlement is one factory for every asset

CIP-56 is the token standard; every streamable asset — CC or non-CC — settles
through the same transfer-instruction factory. There is no per-asset
money-moving code path. USDCx's burn / mint is its **issuance** surface (how the
asset is minted or redeemed), not part of the streaming path; a stream only ever
moves existing holdings via a transfer.

### Recipients without a TransferPreapproval

If the recipient has registered a `TransferPreapproval`, each cycle delivers
directly. If not, the cycle's transfer lands as a **pending offer** (a
`TransferInstruction`) the recipient must `Accept` before money moves — the cycle
counts as settled only once accepted. Each offer carries an `executeBefore`
deadline: once it passes, the recipient can no longer accept, and the sender can
reclaim the funds with `TransferInstruction_Withdraw`. The offer / expiry
lifecycle itself is covered in [SETTLEMENT-DESIGN.md](../SETTLEMENT-DESIGN.md).

---

## Streaming a non-CC asset through the Vault (operator-custodied escrow) lane

Everything above configures the **direct-transfer** lane
(`POST /api/v1/streams`), where the payer's wallet signs every cycle. The **Vault**
lane — operator-custodied escrow, `POST /api/v1/escrows` — is the "deposit once,
operator streams" path: the payer funds a single deposit into the operator's
custody party, and the operator releases it to the payee on a schedule with no
further payer signature per cycle (custodial by construction; see
[SETTLEMENT-DESIGN.md](../SETTLEMENT-DESIGN.md)).

The Vault lane now custodies non-CC whitelisted assets too. It resolves the asset
from the **same** proxy whitelist as the direct lane (`getSupportedAssets()`,
surfaced at `GET /api/assets`) — there is no separate vault asset config. So once
an asset's `<KEY>_ADMIN_PARTY` + `<KEY>_REGISTRY_API_URL` are set (see
[Configuring a non-CC asset](#configuring-a-non-cc-asset) above), that asset is
vault-able as well as streamable.

### Creating a non-CC vault

Pass `assetKey` when you fund the vault — both when the wallet forms its own
deposit and when you create the escrow:

```jsonc
// POST /api/v1/escrows/prepare-deposit   (wallet-signed deposit path)
{ "payer": "...", "totalDeposit": "1000.0", "assetKey": "usdcx" }

// POST /api/v1/escrows
{ "recipient": "...", "assetKey": "usdcx",
  "totalDeposit": "1000.0", "ratePerCycle": "10.0", "cadenceSeconds": 86400 /* ... */ }
```

* `assetKey` **absent** or `"cc"` ⇒ Canton Coin — the vault deposits, releases,
  reconciles, and caps byte-for-byte as before (no per-vault instrument stored).
* An **unknown or unconfigured** `assetKey` ⇒ `400 { "reason": "unknown_asset" }`,
  rejected **before** any deposit transfer fires, so funds are never moved into an
  unroutable vault.

As with a direct stream, the chosen instrument — admin, instrument id, registry
base, holding template, transfer version — is **frozen onto the vault at create
time**; every later release, refund, and on-chain verify reads the frozen
instrument.

### Per-asset custody cap

Each asset has its own aggregate custody ceiling, so a single commingled key is
never trusted with more than that:

| Env var | Applies to | Default | What it caps |
|---|---|---|---|
| `ESCROW_MAX_TOTAL_CC` | Canton Coin vaults | — | Total tracked CC obligation across active CC vaults |
| `ESCROW_MAX_TOTAL_<KEY>` | Vaults of asset `<KEY>` (upper-cased) | `0` (disabled) | Total tracked obligation across active vaults of that asset |

`<KEY>` is the whitelist key upper-cased — e.g. `usdcx` ⇒ `ESCROW_MAX_TOTAL_USDCX`.
A deposit that would raise the tracked obligation **for that asset** past its cap
is rejected with `409 { "reason": "escrow_cap_exceeded" }`. A cap of `0` (the
non-CC default) disables the check for that asset; CC keeps its existing
`ESCROW_MAX_TOTAL_CC` behaviour unchanged.

### Custody pools and the solvency interlock are per-asset

Deposits of the same asset are commingled in the one operator custody party, but
each asset is an **independent pool**. The obligation owed to active vaults is
tallied per asset key, and before every release or refund the operator checks that
the custody party's **free balance in that asset** covers the total owed **for that
asset**. One asset's balance can never cover another's obligation, so a shortfall
in one asset cannot reach another asset's depositors. A tripped interlock returns
`409 { "reason": "escrow_pool_insolvent" }`. A continuous read-only drift probe
runs the same per-asset check on a timer and logs `escrow_solvency_drift` for an
external pager.

The custody free balance is read per asset: CC from its concrete Amulet holdings,
a non-CC asset through the standardized Holding interface view — only **unlocked**
holdings of the matching instrument count as free balance.

### Reclaiming an expired non-CC release

If the recipient has no `TransferPreapproval`, a release lands as a **pending
offer** the recipient must `Accept` (as in the direct lane), each carrying an
`executeBefore` deadline. What happens to an offer that expires unaccepted differs
by asset:

* **CC** — an expired CC offer is swept back to the sender automatically, and
  reconcile reverts the release. Nothing to do.
* **A non-CC asset has no auto-sweep.** An offer the recipient never accepts would
  otherwise strand the funds in a dead offer. Because the custody party is the
  release's sender, it **withdraws** the expired offer
  (`TransferInstruction_Withdraw`, exercisable even after the deadline), returning
  the value to custody where it re-enters the vault's refundable / re-releasable
  balance.

That reclaim runs **automatically each streamer tick** for non-CC vaults, and can
also be triggered on demand by the payer:

```
POST /api/v1/escrows/:id/reclaim      # payer only; a no-op for a CC vault
→ { "reclaimed": <number of offers withdrawn> }
```

Only an offer still locked on-ledger past its deadline is withdrawn; one already
accepted or previously reclaimed is left untouched. The offer / expiry lifecycle
itself is covered in [SETTLEMENT-DESIGN.md](../SETTLEMENT-DESIGN.md).
