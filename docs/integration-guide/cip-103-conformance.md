# CIP-103 Conformance

How to validate your Canton Payment Streams integration against the
CIP-103 dApp API standard.

CIP-103 defines the OpenRPC contract between a dApp and a wallet
provider. Canton Payment Streams' wallet provider (in
`packages/dashboard/src/store/wallet/`) is designed to pass the official
OpenRPC conformance suite published in `splice-wallet-kernel`.

This guide is for **dApp developers** who want their own integration
verified against CIP-103, and for **wallet developers** who want to
verify their wallet is compatible with Canton Payment Streams.

---

## Quick conformance check

There is no bundled CIP-103 OpenRPC conformance suite in this repo. What
ships today is a set of wallet-client contract/capability tests
(`packages/dashboard/src/store/wallet/walletClient.test.ts`):

```bash
pnpm --filter @canton-streams/dashboard test walletClient
```

These verify the wallet-provider client shape and capability flags:

1. Provider lifecycle (`connect` → `disconnect` → `status`)
2. Account discovery (`listAccounts`)
3. Transaction preparation + submission (`prepareExecuteAndWait`)
4. Ledger API proxy (`ledgerApi`)
5. Event delivery (`accountsChanged`, `statusChanged`, `txChanged`)
6. Capability flags (`hostedMultiWallet`, `openSurfacesWalletUi`,
   `ledgerApi`, `prepareExecuteAndWait`, `v2AllocationRequestUx`)

Note that method-level CIP-103 behaviors — `signMessage`, `getNetwork`
(CAIP-2 networkId), and EIP-1474 error-code propagation — are spec
requirements that are **not yet implemented** in the wallet-provider
clients. Validate those against the upstream OpenRPC suite below.

---

## Full OpenRPC conformance suite

For a complete CIP-103 validation, run the upstream
`splice-wallet-kernel` test suite:

```
# Clone the kernel repo
git clone https://github.com/canton-foundation/splice-wallet-kernel
cd splice-wallet-kernel

# Point the conformance harness at your Provider
SWK_PROVIDER_URL=http://your-dapp.example/.well-known/cip103-provider \
  npm run conformance
```

The harness expects a JSON-RPC-over-HTTP endpoint matching the
published OpenRPC contract. The Canton Payment Streams wallet provider
implements this via the `dapp-sdk` and `partylayer` clients — see
`packages/dashboard/src/store/wallet/`.

---

## Required behaviors

Per CIP-103, a conformant Provider must:

- Accept the `request<T>({ method, params })` envelope (EIP-1193-style)
- Emit `accountsChanged` when the user switches account in the wallet
- Emit `statusChanged` when connection state changes
- Emit `txChanged` for each phase of a transaction lifecycle: `pending`
  → `signed` → `executed` (or `failed`)
- Return EIP-1474-shaped error objects: `{ code, message, data? }`
- Use CAIP-2 format for `networkId` (e.g. `canton:da-mainnet`)
- Honor user rejection: throw `4001 USER_REJECTED` if the user cancels
  in the wallet UI
- Allow read paths to be proxied via `ledgerApi` OR direct (with
  wallet-issued access token)

For production readiness, verify CIP-103 conformance against more than
one independent wallet implementation — the Splice Wallet Kernel
(canonical reference, `canton-foundation/splice-wallet-kernel`) plus at
least one other wallet implementing the OpenRPC contract — and confirm a
complete stream lifecycle (create → accept → withdraw) through each.

---

## Reporting issues

CIP-103 conformance issues should be reported to:

- The CIP-103 spec process (canton-foundation/cips repo) for spec
  ambiguities
- This repo's GitHub Issues for Canton Payment Streams wallet-provider bugs
- The respective wallet's issue tracker for wallet-side issues
