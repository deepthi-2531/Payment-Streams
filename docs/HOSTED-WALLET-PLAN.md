# Hosted Wallet Integration Plan

This repo supports two wallet paths:

1. `dapp-sdk` / Amulet gateway for LocalNet and standards-conformance testing.
2. PartyLayer for hosted multi-wallet UX, especially 5N Loop users.

The current implementation starts with a wallet-neutral dashboard contract in
`packages/dashboard/src/store/wallet/`. The existing Amulet path is adapted into
that contract first; PartyLayer will be added as the second implementation.

## Feature flags

```env
# LocalNet / standards testing. This is the default.
VITE_WALLET_LAYER=dapp-sdk
VITE_WALLET_GATEWAY_URL=http://localhost:3030/api/v0/dapp
VITE_SKIP_WALLET_PICKER=true

# Hosted multi-wallet UX. DEX-85 wires this implementation.
VITE_WALLET_LAYER=partylayer
```

`VITE_WALLET_PROVIDER` is accepted as a backwards-compatible alias for
`VITE_WALLET_LAYER`.

## Implementation tickets

- STR-130: add the wallet-provider abstraction and keep the Amulet path working.
- STR-131: add PartyLayer hosted wallet UX.
- STR-132: map PartyLayer capabilities to Streams signing and ledger APIs.
- STR-133: run hosted-wallet E2E against V2 Streams flows.
- STR-134: document the hosted wallet support matrix and limitations.
