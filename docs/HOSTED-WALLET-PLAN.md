# Hosted Wallet Integration

Canton Payment Streams keeps the protocol and SDK independent from any
single wallet. The dashboard selects a wallet layer through
`packages/dashboard/src/store/wallet/`, and both layers implement the
same `StreamsWalletClient` contract.

## Wallet Layers

| Layer | Use it for | Notes |
| --- | --- | --- |
| `dapp-sdk` | LocalNet, standards testing, Amulet wallet gateway flows | Default path. Uses `@canton-network/dapp-sdk` with a CIP-103 wallet gateway. |
| `partylayer` | Hosted multi-wallet UX for deployed dApps | Uses `@partylayer/sdk` so users can pick wallets such as 5N Loop or Console. |

The protocol implementation stays the same in both modes. The wallet layer
only changes how the user connects, selects an account, opens wallet UI, and
submits wallet-mediated commands.

## Configuration

```env
# LocalNet / standards testing. This is the default.
VITE_WALLET_LAYER=dapp-sdk
VITE_WALLET_GATEWAY_URL=http://localhost:3030/api/v0/dapp
VITE_SKIP_WALLET_PICKER=true
VITE_WALLET_NAME=Splice Amulet Wallet

# Hosted multi-wallet UX.
VITE_WALLET_LAYER=partylayer
VITE_PARTYLAYER_NETWORK=devnet
VITE_PARTYLAYER_APP_NAME=Canton Payment Streams
```

`VITE_WALLET_PROVIDER` is accepted as a backwards-compatible alias for
`VITE_WALLET_LAYER`. `VITE_WALLET_NETWORK` is accepted as a fallback for
`VITE_PARTYLAYER_NETWORK`.

## Capability Matrix

Call sites read `walletClient.capabilities` instead of checking concrete
client types. See `packages/dashboard/src/store/wallet/types.ts` for the
contract.

| Capability | `dapp-sdk` | `partylayer` |
| --- | --- | --- |
| `ledgerApi` | true | true |
| `prepareExecuteAndWait` | true | false |
| `v2AllocationRequestUx` | true | depends on the selected wallet |
| `hostedMultiWallet` | false | true |
| `openSurfacesWalletUi` | true | false |

PartyLayer currently exposes ledger access and hosted wallet selection, but
the dashboard does not claim automatic `prepareExecuteAndWait` support for
that layer. In hosted mode, the user completes approval in the selected
wallet's own UI and then returns to the dashboard. When the hosted provider
exposes a wait-for-completion method, the `partylayer` client can flip the
capability and route the same approval payload through it.

## Wallet Support Matrix

| Wallet | Recommended layer | Expected use |
| --- | --- | --- |
| Splice Amulet Wallet | `dapp-sdk` | LocalNet and standards-conformance testing. |
| 5N Loop | `partylayer` | Primary hosted-wallet target for deployed dApps. |
| Console Wallet | `partylayer` | Browser-extension testing and developer flows. |
| Cantor8 | `partylayer` | Hosted wallet selection through PartyLayer. |
| Nightly | `partylayer` | Hosted wallet selection when available on the target network. |
| Send | `partylayer` | Hosted wallet selection when available on the target network. |
| Bron | custom PartyLayer config | Requires OAuth configuration before it can be enabled. |

Streams does not gate behavior by wallet brand. If a selected wallet cannot
submit the V2 allocation or settlement command shape, the dashboard should
surface that as a wallet capability failure rather than silently falling back
to an older flow.

## Recommended Paths

| Scenario | Recommended layer | Recommended wallet |
| --- | --- | --- |
| Local development | `dapp-sdk` | Splice Amulet Wallet on LocalNet |
| Standards testing | `dapp-sdk` | Splice Amulet Wallet |
| Hosted devnet/testnet dApp | `partylayer` | 5N Loop or Console Wallet |
| Hosted mainnet dApp | `partylayer` | 5N Loop |
| CI or headless tests | `dapp-sdk` | Local wallet gateway or test double |

## Known Limitations

- Hosted wallet approval is truthful but manual today: PartyLayer mode can
  connect, list accounts, and route ledger access, but approval completion
  happens in the selected wallet UI until the hosted provider exposes an
  automatic prepare-and-wait path.
- Capability flags are the source of truth. Any new wallet behavior should
  update `WalletCapabilities`, both client implementations, and
  `packages/dashboard/src/store/wallet/walletClient.test.ts`.
- Wallet-specific DAR allowlists are outside PartyLayer's control. A hosted
  wallet can support Token Standard flows while still refusing a custom app
  command shape until that package is allowlisted by the wallet.

## Files Of Record

| File | Role |
| --- | --- |
| `packages/dashboard/src/store/wallet/types.ts` | Wallet client contract and capabilities. |
| `packages/dashboard/src/store/wallet/config.ts` | Environment parsing and defaults. |
| `packages/dashboard/src/store/wallet/dappSdkClient.ts` | Amulet / CIP-103 gateway adapter. |
| `packages/dashboard/src/store/wallet/partyLayerClient.ts` | PartyLayer adapter. |
| `packages/dashboard/src/store/wallet/index.ts` | Wallet layer resolver. |
| `packages/dashboard/src/store/wallet/walletClient.test.ts` | Contract tests for both layers. |
| `docs/E2E-HARNESS.md` | Operator runbook for wallet-backed E2E testing. |
