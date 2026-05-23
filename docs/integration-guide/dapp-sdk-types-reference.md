# `@canton-network/dapp-sdk` — Verified Types Reference

> **Verified against** `hyperledger-labs/splice-wallet-kernel@main` source as of
> May 2026. Field names and shapes here are read directly from the SDK's
> TypeScript source, not speculation. When this reference disagrees with the
> upstream, the upstream wins — this file should be regenerated.

## Package

```
@canton-network/dapp-sdk
v1.1.0 (latest verified)
license: Apache-2.0
main: dist/index.cjs
module: dist/index.js
types: dist/index.d.ts
```

Source: <https://github.com/hyperledger-labs/splice-wallet-kernel/tree/main/sdk/dapp-sdk>

## Two integration paths

The same SDK exposes both:

| Path | Surface | Use when |
|---|---|---|
| **Module-level convenience API** | `import * as sdk from '@canton-network/dapp-sdk'` | Single dApp, default singleton client. Recommended for most apps. |
| **`DappClient` class** | `import { DappClient } from '@canton-network/dapp-sdk'` | Multiple wallets simultaneously, custom adapter wiring, advanced/library use. |

Both call the same underlying `Provider<DappRpcTypes>`.

## RPC method surface (verified)

All methods live on `DappClient` (and as module-level exports for the singleton):

```typescript
class DappClient {
  async connect(): Promise<ConnectResult>
  async disconnect(): Promise<void>
  async isConnected(): Promise<ConnectResult>
  async status(): Promise<StatusEvent>
  async listAccounts(): Promise<ListAccountsResult>             // = Wallet[]
  async prepareExecute(params: PrepareExecuteParams): Promise<null>           // fire-and-forget
  async prepareExecuteAndWait(params: PrepareExecuteParams): Promise<PrepareExecuteAndWaitResult>
  async signMessage(params: SignMessageParams): Promise<SignMessageResult>
  async ledgerApi(params: LedgerApiParams): Promise<LedgerApiResult>

  onStatusChanged(listener)
  onAccountsChanged(listener)
  onConnected(listener)
  onTxChanged(listener)
  onMessageSignature(listener)
  removeOnStatusChanged / removeOnAccountsChanged / removeOnConnected
    / removeOnTxChanged / removeOnMessageSignature

  async open(): Promise<void>     // opens the wallet's user UI
  getProvider(): Provider<DappRpcTypes>
}
```

## Types (verified from `@canton-network/core-wallet-dapp-rpc-client`)

### Connection lifecycle

```typescript
interface ConnectResult {
  isConnected: boolean
  reason?: string
  isNetworkConnected: boolean
  networkReason?: string
  userUrl?: string
}

interface StatusEvent {
  provider: Provider          // { id, version?, providerType?, url?, userUrl? }
  connection: ConnectResult
  network?: Network           // { networkId, ledgerApi?, accessToken? }
  session?: Session           // { accessToken, userId }
}

interface Session {
  accessToken: string         // ← JWT held by the SDK; dApp NEVER pastes one
  userId: string
}

interface Network {
  networkId: string           // CAIP-2-style, e.g. "canton:da-mainnet"
  ledgerApi?: string          // base URL of the ledger API (proxy or direct)
  accessToken?: AccessToken
}
```

### Accounts ("wallets" in CIP-103 vocabulary)

```typescript
type ListAccountsResult = Wallet[]
type AccountsChangedEvent = Wallet[]

interface Wallet {
  primary: boolean
  partyId: string             // ← the Canton party identifier
  status: 'initialized' | 'allocated' | 'removed'
  hint: string
  publicKey: string
  namespace: string
  networkId: string
  signingProviderId: string   // ← which signing provider holds the key
  externalTxId?: string
  topologyTransactions?: string
  disabled?: boolean
  reason?: string
}
```

**Important**: `connect()` does **NOT** return accounts. Call `listAccounts()`
separately after `connect()` resolves with `isConnected: true`.

### Transaction submission

```typescript
interface PrepareExecuteParams {
  commandId?: string
  commands: Command[]                          // Daml Ledger API command atoms
  actAs?: Party[]                              // parties to act as (defaults to primary)
  readAs?: Party[]
  disclosedContracts?: DisclosedContract[]
  synchronizerId?: string
  packageIdSelectionPreference?: PackageId[]
}

type Command =
  | { CreateCommand: { /* opaque, matches Ledger API */ } }
  | { ExerciseCommand: { /* opaque */ } }
  | { CreateAndExerciseCommand: { /* opaque */ } }
  | { ExerciseByKeyCommand: { /* opaque */ } }

interface PrepareExecuteAndWaitResult {
  tx: TxChangedExecutedEvent
}

// txChanged event union — subscribe to all four statuses via onTxChanged()
type TxChangedEvent =
  | { status: 'pending';  commandId: string }
  | { status: 'signed';   commandId: string; payload: { signature, signedBy, party } }
  | { status: 'executed'; commandId: string; payload: { updateId, completionOffset } }
  | { status: 'failed';   commandId: string }
```

### Reading the ledger

```typescript
interface LedgerApiParams {
  requestMethod: 'get' | 'post' | 'patch' | 'put' | 'delete'
  resource: string                   // e.g. "/v2/state/active-contracts"
  body?: { [k: string]: any }
  query?: { [k: string]: any }
  path?: { [k: string]: any }
}

type LedgerApiResult = { [k: string]: any }
```

The Wallet Gateway proxies these to the ledger. The dApp **does NOT** talk to
the Ledger API directly.

### Signing arbitrary messages (rare)

```typescript
interface SignMessageParams { message: string }
interface SignMessageResult { signature: string }
```

## Adapters + discovery

`DappSDK.connect(options)` registers + auto-detects wallets. Wallets come from
three sources:

1. **Default gateways**: `gateways.json` shipped with the SDK
2. **`additionalAdapters`**: caller-supplied
3. **EIP-6963-style announced extensions**: `requestAnnouncedProviders()`
   dispatches the event `canton:requestProvider`; browser-extension wallets
   respond with `canton:announceProvider` carrying `{ id, name, icon?, target? }`

**Verified event names** (from `@canton-network/core-types`):

```typescript
export const CANTON_REQUEST_PROVIDER_EVENT  = 'canton:requestProvider'  as const
export const CANTON_ANNOUNCE_PROVIDER_EVENT = 'canton:announceProvider' as const
```

```typescript
class RemoteAdapter {
  constructor(config: {
    name: string
    rpcUrl: string                 // e.g. 'https://gateway.example.com/api/v0/dapp'
    providerId?: string
    icon?: string
    description?: string
  })
  // type: 'remote'
}

class ExtensionAdapter {
  constructor(config: {
    providerId?: string
    name?: string                  // defaults to 'Browser Extension'
    icon?: string
    description?: string
    target?: string                // routing key for postMessage
  } = {})
  // type: 'browser'
}
```

### Recommended bootstrap

```typescript
import * as sdk from '@canton-network/dapp-sdk'

// 1. Early (e.g. app mount) — registers adapters, tries to restore prior session
await sdk.init()

// 2. When the user clicks "Connect Wallet"
const result = await sdk.connect()
if (!result.isConnected) {
  // surface result.reason in UI
  return
}

// 3. Get accounts
const accounts = await sdk.listAccounts()
const primary = accounts.find((w) => w.primary)

// 4. Subscribe to lifecycle events
sdk.onTxChanged((evt) => {
  switch (evt.status) {
    case 'pending':  /* spinner */ break
    case 'signed':   /* "awaiting ledger" */ break
    case 'executed': /* refresh state with evt.payload.updateId */ break
    case 'failed':   /* error */ break
  }
})

sdk.onAccountsChanged((accounts) => { /* re-render */ })

// 5. Submit a write — wallet signs, gateway submits
await sdk.prepareExecuteAndWait({
  commands: [{ ExerciseCommand: { /* ... */ } }],
  actAs: [primary.partyId],
})

// 6. Read state
const acs = await sdk.ledgerApi({
  requestMethod: 'post',
  resource: '/v2/state/active-contracts',
  body: { /* filter */ },
})
```

## Notable corrections vs. my earlier walkthrough

| Earlier (speculative) | Correct (verified) |
|---|---|
| `connect()` returns `{ sessionId, accessToken, accounts }` | `connect()` returns `ConnectResult { isConnected, isNetworkConnected, ... }`. Accounts come from `listAccounts()`; access token comes from `status().session.accessToken`. |
| Event field for executed: `{ updateId }` directly | `{ status: 'executed', commandId, payload: { updateId, completionOffset } }` |
| Discovery: `window.canton` window-property | EIP-6963-style `canton:requestProvider` / `canton:announceProvider` events |
| `prepareExecute()` blocks until executed | `prepareExecute()` returns `null` (fire-and-forget); use `prepareExecuteAndWait()` to wait, OR subscribe to `txChanged` |
| Account had `.party` | Account has `.partyId` |
| Account had `provider` | Account has `signingProviderId` |

## Package pinning recommendation

The SDK is pre-1.0.0-style (currently `1.1.0` but expects breaking changes).
Pin to an exact version in `package.json`:

```json
"dependencies": {
  "@canton-network/dapp-sdk": "1.1.0"
}
```

Flag any breaking changes in our CHANGELOG when bumping.

## Sources

- `sdk/dapp-sdk/src/index.ts` — top-level exports
- `sdk/dapp-sdk/src/sdk.ts` — `DappSDK` class + module-level singleton API
- `sdk/dapp-sdk/src/client.ts` — `DappClient` class
- `sdk/dapp-sdk/src/adapter/remote-adapter.ts` — `RemoteAdapter`
- `sdk/dapp-sdk/src/adapter/extension-adapter.ts` — `ExtensionAdapter`
- `sdk/dapp-sdk/src/announce-discovery.ts` — EIP-6963-style discovery
- `core/wallet-dapp-rpc-client/src/index.ts` — all RPC types
- `core/types/src/index.ts` — `CANTON_REQUEST_PROVIDER_EVENT` / `CANTON_ANNOUNCE_PROVIDER_EVENT`
