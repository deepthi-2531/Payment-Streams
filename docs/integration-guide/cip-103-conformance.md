# CIP-103 Conformance

How to validate your Canton Payment Streams integration against the
CIP-103 dApp API standard.

CIP-103 defines the OpenRPC contract between a dApp and a wallet
provider. Canton Payment Streams' CIP-103 Provider (in
`packages/dashboard/src/lib/cip103/`) is designed to pass the official
OpenRPC conformance suite published in `splice-wallet-kernel`.

This guide is for **dApp developers** who want their own integration
verified against CIP-103, and for **wallet developers** who want to
verify their wallet is compatible with Canton Payment Streams.

---

## Quick conformance check

Run the SDK's bundled conformance test against your CIP-103 Provider:

```
npm test --workspace=@canton-streams/sdk -- cip-103
```

This exercises:

1. Provider lifecycle (`connect` → `disconnect` → `isConnected`)
2. Account discovery (`listAccounts`, `getPrimaryAccount`)
3. Signing (`signMessage`)
4. Transaction preparation + submission (`prepareExecute`)
5. Ledger API proxy (`ledgerApi`)
6. Network identification (`getNetwork` with CAIP-2 networkId)
7. Event delivery (`accountsChanged`, `statusChanged`, `txChanged`)
8. EIP-1474 error code propagation

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
published OpenRPC contract. The Canton Payment Streams Provider
implements this via the sync or async transport — see
`packages/dashboard/src/lib/cip103/transports/`.

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

---

## Two-wallet certification (M4 requirement)

The proposal commits to CIP-103 conformance verified against **at least
two independent wallet implementations** before M4 acceptance. Reference
wallets:

1. **Splice Wallet Kernel** (canonical reference) — `canton-foundation/splice-wallet-kernel`
2. **At least one external wallet** implementing the OpenRPC contract

Each wallet must demonstrate a complete stream lifecycle (create →
accept → withdraw) on Canton mainnet via the Canton Payment Streams
dashboard.

The certification artifact is a Markdown report committed under
`docs/validation/cip-103-conformance-<wallet>.md` describing:

- Wallet version + provider URL
- Conformance test results
- Any spec-drift issues encountered + remediations
- Sign-off by the wallet maintainer

---

## Reporting issues

CIP-103 conformance issues should be reported to:

- The CIP-103 spec process (canton-foundation/cips repo) for spec
  ambiguities
- This repo's GitHub Issues for Canton Payment Streams Provider bugs
- The respective wallet's issue tracker for wallet-side issues

For coordinated reporting where multiple parties are involved, file
in this repo and CC the others.