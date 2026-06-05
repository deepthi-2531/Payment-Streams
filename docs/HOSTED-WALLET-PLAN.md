# Hosted Wallet Integration Plan

This repo supports two wallet paths through a single neutral contract
in `packages/dashboard/src/store/wallet/`:

1. **`dapp-sdk` / Amulet gateway** — `@canton-network/dapp-sdk` + a
   CIP-103 Amulet wallet gateway (`@canton-network/wallet-gateway-remote`).
   The default. Use this for LocalNet, standards-conformance testing,
   and the upstream-aligned receiver flow (the
   `walletClient.prepareExecuteAndWait` swap targets this layer
   against an Amulet build from canton-network/splice#5697).
2. **PartyLayer** — `@partylayer/sdk` 0.4.1. The hosted multi-wallet
   picker. Use this for the user-facing "let me choose a wallet"
   flow, especially when 5N Loop users sign in.

## Feature flags

```env
# LocalNet / standards testing. This is the default.
VITE_WALLET_LAYER=dapp-sdk
VITE_WALLET_GATEWAY_URL=http://localhost:3030/api/v0/dapp
VITE_SKIP_WALLET_PICKER=true
VITE_WALLET_NAME=Splice Amulet Wallet (LocalNet V2)

# Hosted multi-wallet UX (STR-131).
VITE_WALLET_LAYER=partylayer
VITE_PARTYLAYER_NETWORK=devnet            # or 'testnet' / 'mainnet'
VITE_PARTYLAYER_APP_NAME=Canton Payment Streams
```

`VITE_WALLET_PROVIDER` is accepted as a backwards-compatible alias for
`VITE_WALLET_LAYER`. `VITE_WALLET_NETWORK` is accepted as a fallback
for `VITE_PARTYLAYER_NETWORK`.

## Implementation tickets

- **STR-130** — wallet-provider abstraction; the existing Amulet path
  is adapted into the new contract.
- **STR-131** — PartyLayer hosted-wallet adapter
  (`packages/dashboard/src/store/wallet/partyLayerClient.ts`). Wires
  `@partylayer/sdk`'s `PartyLayerClient` into the
  `StreamsWalletClient` shape via the SDK's `asProvider()` CIP-0103
  bridge for `prepareExecuteAndWait` / `ledgerApi`. The PartyLayer
  bundle is lazy-imported so the default dapp-sdk path does not pay
  the cost.
- **STR-132** — capability mapping
  (`WalletCapabilities` on `types.ts`). Drives gate decisions at
  call sites without `typeof method === 'function'` sniffs.
- **STR-133** — hosted-wallet E2E against the V2 Streams flows
  (`docs/E2E-HARNESS.md` "Hosted-wallet E2E").
- **STR-134** — this support matrix.

## Capability matrix

The dashboard call sites read `walletClient.capabilities` to decide
which flows are exercisable. See
`packages/dashboard/src/store/wallet/types.ts` for the canonical
shape. The two shipped clients claim:

| Capability                  | dapp-sdk client | partylayer client |
| --------------------------- | --------------- | ----------------- |
| `ledgerApi`                 | true            | true              |
| `prepareExecuteAndWait`     | true            | **false** (see note) |
| `v2AllocationRequestUx`     | true            | depends on wallet |
| `hostedMultiWallet`         | false           | true              |
| `openSurfacesWalletUi`      | true            | false             |

> **`prepareExecuteAndWait` on partylayer is currently false.**
> `@partylayer/provider@0.1.7`'s bridge implements the fire-and-forget
> `prepareExecute` method but not `prepareExecuteAndWait`. We advertise
> the capability honestly so call-sites do not invoke an unsupported
> method. When an upstream release adds it, flip the flag back to true
> in `packages/dashboard/src/store/wallet/partyLayerClient.ts` (a
> commented-out implementation is left there for the swap).

Notes:

- `prepareExecuteAndWait` on the partylayer client routes through
  `PartyLayerClient.asProvider()`'s CIP-0103 `Provider`. PartyLayer's
  bridge implements the full CIP-0103 spec (10 mandatory methods +
  full tx lifecycle), so the inbox receiver-flow swap from
  `walletClient.open()` to `walletClient.prepareExecuteAndWait(...)`
  works against PartyLayer-routed wallets too — provided the
  *underlying* wallet supports the V2 AllocationRequest accept
  command shape.
- `v2AllocationRequestUx` is "depends on wallet" on the partylayer
  client because the picker can route to wallets that do not yet
  ship the splice#5697 receiver UX. The capability surfaces "true"
  to keep the dashboard willing to attempt the round-trip; the
  result error (`UserRejectedError` / `CapabilityNotSupportedError`)
  is what the user sees if the picked wallet refuses.

## Wallet support matrix (partylayer adapter set)

PartyLayer 0.4.x ships built-in adapters for these wallets. The
matrix records what the dashboard expects to work via each.

| Wallet           | npm adapter package          | In PL 0.4.1 default set | V2 AllocationRequest accept | Notes |
| ---------------- | ---------------------------- | ----------------------- | --------------------------- | ----- |
| Amulet / splice  | (via dapp-sdk, not partylayer) | n/a                  | yes (on splice#5697)        | Default LocalNet path. |
| 5N Loop          | `@partylayer/adapter-loop`   | **yes**                 | follow upstream             | Hosted; deep-link / QR transport. The main user-facing target for partylayer mode. |
| Console Wallet   | `@partylayer/adapter-console`| **yes**                 | follow upstream             | Browser extension. |
| Cantor8 (C8)     | `@partylayer/adapter-cantor8`| **yes**                 | follow upstream             | Deep-link. |
| Nightly          | `@partylayer/adapter-nightly`| **yes**                 | follow upstream             | Multichain browser-extension wallet. |
| Send             | `@partylayer/adapter-send`   | **yes**                 | follow upstream             | Passkey-based, `kernel.id`-guarded `window.canton`. |
| Bron             | `@partylayer/adapter-bron`   | no                      | follow upstream             | OAuth-backed; needs `BronAdapterConfig` the dashboard does not pass — opt-in by overriding `adapters` in `partyLayerClient.ts`. |

"follow upstream" means: the wallet either currently supports the V2
AllocationRequest receiver UX, or will when it adopts the
canton-network/splice#5697 receiver semantics. The dashboard does
not gate by wallet identity; the underlying capability check happens
at the wallet level.

The partylayer client's `connect()` uses PartyLayer's default
adapter set as of `@partylayer/sdk@0.4.1` —
**Console + Loop + Cantor8 + Nightly + Send** (verified against
`getBuiltinAdapters()` in the installed SDK). Bron is not in that
set because it requires OAuth config we do not pass today; to add
it, override `adapters` in `createPartyLayer(...)` inside
`packages/dashboard/src/store/wallet/partyLayerClient.ts`.

## Recommended wallet paths

| Scenario                                    | Recommended layer | Recommended wallet                         |
| ------------------------------------------- | ----------------- | ------------------------------------------ |
| LocalNet, V2 receiver-flow development      | dapp-sdk          | Amulet built from splice#5697 preview      |
| Live testnet, single-user dev / probes      | dapp-sdk          | Amulet on the connected validator          |
| End-user dApp on devnet/testnet (multi-wallet) | partylayer     | Loop (primary) or Console (extension)      |
| End-user dApp on mainnet                    | partylayer        | Loop                                       |
| Headless / CI                               | dapp-sdk          | A mock or LocalNet-built Amulet            |

## Known limitations

1. **Iterated-settlement receiver UX** depends on upstream
   canton-network/splice#5697 landing in the chosen wallet build.
   The harness pin `SPLICE_PR5697_PREVIEW_COMMIT` in
   `scripts/fetch-v2-dars.mjs` is the dev-mode target. Once merged
   into `token-standard-v2-upcoming`, the regular Amulet wallet
   builds will pick the receiver UX up.
2. **CJS `require()` in `PartyLayerClient.asProvider()`**: the SDK's
   `client.asProvider()` lazily resolves the provider bridge via a
   synchronous CommonJS `require('@partylayer/provider')`. Vite's ESM
   dev server cannot resolve that at runtime (verified live:
   `Dynamic require of "@partylayer/provider" is not supported`),
   so `partyLayerClient.ts` imports `@partylayer/provider` as a
   direct dependency and constructs the bridge via the ESM
   `createProviderBridge(client)` export. The Provider surface is
   identical, the CJS hazard is gone. If the upstream SDK fixes the
   loader (issues a real ESM `import()`), we can switch back to
   `client.asProvider()` and drop the direct `@partylayer/provider`
   dep.
3. **Capability flag drift**: `WalletCapabilities` is the
   single source of truth. Tests in
   `packages/dashboard/src/store/wallet/walletClient.test.ts`
   lock the contract; adding a new wallet capability is a contract
   change that must update both shipped clients.

## Files of record

| File                                                       | Role                                           |
| ---------------------------------------------------------- | ---------------------------------------------- |
| `packages/dashboard/src/store/wallet/types.ts`             | `StreamsWalletClient` + `WalletCapabilities`   |
| `packages/dashboard/src/store/wallet/config.ts`            | `VITE_*` env reading + defaults                |
| `packages/dashboard/src/store/wallet/dappSdkClient.ts`     | dapp-sdk adapter                               |
| `packages/dashboard/src/store/wallet/partyLayerClient.ts`  | PartyLayer adapter (lazy-loaded)               |
| `packages/dashboard/src/store/wallet/index.ts`             | layer resolver                                 |
| `packages/dashboard/src/store/wallet/walletClient.test.ts` | contract tests                                 |
| `docs/E2E-HARNESS.md`                                      | hosted-wallet E2E section (STR-133)            |
