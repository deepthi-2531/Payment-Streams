# Wallet Gateway Server-Side API — Verified Reference

> **Verified against** `hyperledger-labs/splice-wallet-kernel@main` docs
> (`docs/dapp-building/wallet-gateway/`) as of May 2026. When this reference
> disagrees with the upstream, the upstream wins.

## Wire protocol: JSON-RPC 2.0 (not REST)

**Historical note (V1 settlement-reference path, no longer used).** The
`AmuletWalletGatewayAdapter` in `packages/sdk/src/settlement/adapters/amulet.ts`
calls `/api/wallet-gateway/prepare-action` + `/execute-action` as REST POST
endpoints. That endpoint shape was the older V1 settlement-reference path
that this library has since dropped. New stream creation goes through the
CIP-103 wallet flow described below; the legacy adapter is retained only
for parsing/migration compatibility and is not exercised by the live code
path.

The current Wallet Gateway exposes:

| Endpoint | Purpose | Auth |
|---|---|---|
| `/api/v0/dapp` | JSON-RPC 2.0 dApp API (CIP-103 method set) | JWT in `Authorization: Bearer` |
| `/api/v0/dapp/events` | Server-Sent Events (txChanged, accountsChanged, statusChanged, connected) | JWT as `?token=` query or `Authorization` header |
| `/api/v0/user` | JSON-RPC 2.0 user-management API (wallets, networks, IdPs) | JWT; some methods unauthenticated (see below) |

There is **no REST surface**. The "prepare" + "execute" semantics are
delivered via the CIP-103 `prepareExecute` JSON-RPC method, which the gateway
internally routes through the bound signing provider for the party named in
`actAs`.

## dApp API methods (`/api/v0/dapp`)

Same surface as the dapp-sdk's RPC types — see
[`dapp-sdk-types-reference.md`](./dapp-sdk-types-reference.md) for the
full type listing. Key methods:

- `connect`, `disconnect`, `isConnected`, `status`
- `listAccounts`, `getPrimaryAccount`
- `prepareExecute`, `prepareExecuteAndWait` — these are the
  signing + submission methods (replaces the old REST prepare/execute pair)
- `signMessage`
- `ledgerApi` — proxies arbitrary Ledger API calls

All of these are JSON-RPC 2.0 calls; the SDK wraps them.

## SSE event stream (`/api/v0/dapp/events`)

```javascript
const eventsUrl = new URL('events', dappApiUrl + '/')
eventsUrl.searchParams.set('token', jwtToken)
const eventSource = new EventSource(eventsUrl.toString())
eventSource.addEventListener('accountsChanged', (e) => { /* … */ })
eventSource.addEventListener('statusChanged',   (e) => { /* … */ })
eventSource.addEventListener('connected',       (e) => { /* … */ })
eventSource.addEventListener('txChanged',       (e) => { /* … */ })
```

The dapp-sdk subscribes to these internally; consumers only see them via
`sdk.onTxChanged(...)` etc.

## User API methods (`/api/v0/user`)

Separate from the dApp API. Used by the wallet's UI (not by dApps), but
relevant if you're building a wallet or onboarding operations:

| Category | Methods |
|---|---|
| Sessions | `addSession()` (unauth), `removeSession()`, `listSessions()` |
| Networks | `listNetworks()` (unauth), `addNetwork()`, `removeNetwork()` |
| IdPs | `listIdps()` (unauth), `addIdp()`, `removeIdp()` |
| Wallets | `createWallet()`, `listWallets()`, `setPrimaryWallet()`, `removeWallet()`, `syncWallets()`, `isWalletSyncNeeded()` |
| Transactions | `sign()`, `execute()`, `getTransaction()`, `listTransactions()` |

Unauthenticated methods: `addSession`, `listNetworks`, `listIdps` (needed for
initial connection bootstrap).

## Signing providers (the 5 documented ones)

The Wallet Gateway delegates signing to a **per-party** signing provider.
**Verified list from upstream docs**:

| Provider | Source of keys | Production-ready | Env / config |
|---|---|---|---|
| **Wallet Gateway (Internal)** | Gateway's signing-store DB | ❌ dev/test only | Auto-available when `signingStore` configured |
| **Participant-Based** | Canton participant node's keystore | ✅ enterprise | Always available, no extra config |
| **Fireblocks** | Fireblocks HSM | ✅ enterprise | `FIREBLOCKS_API_KEY` env + key files |
| **Blockdaemon** | Blockdaemon infra | ✅ managed | `BLOCKDAEMON_API_URL`, `BLOCKDAEMON_API_KEY` |
| **Dfns** | Dfns MPC | ✅ enterprise | `DFNS_ORG_ID`, `DFNS_BASE_URL`, `DFNS_CRED_ID`, `DFNS_PRIVATE_KEY`, `DFNS_AUTH_TOKEN` |

The current public provider list has five providers, including Dfns.

Provider selection is **per-party at wallet-creation time** (via the User
API's `createWallet`). One Gateway instance can host parties using different
providers.

## Authentication model

- **dApp ↔ Gateway**: JWT in `Authorization: Bearer <token>` header. The
  dapp-sdk obtains this token via `connect()` (the gateway handles the auth
  flow with whichever IdP is configured) and holds it internally. The dApp
  code never touches it.
- **Gateway ↔ signing provider**: signing-provider-specific. For Fireblocks /
  Blockdaemon / Dfns it's the env-var API keys/credentials. For Participant
  it's the participant's own access model.
- **Gateway ↔ ledger**: gateway uses the JWT it's been configured with for
  the participant node.

The dApp's trust boundary is just "I trust the gateway I'm connecting to."
Keys never live anywhere the dApp can see.

## CORS + rate-limiting

`allowedOrigins` config: defaults to `"*"`; production should pin to known
dApp origins. Rate limit headers (`X-RateLimit-*`) included in responses.

## Config schema reference

The full config schema lives at
`docs/dapp-building/wallet-gateway/configuration/schema.md`. Top-level keys:

```jsonc
{
  "kernel":   { "id": "…", "clientType": "remote" | "browser" | "desktop" | "mobile" },
  "server":   { "port": 3030, "dappPath": "/api/v0/dapp", "userPath": "/api/v0/user",
                "allowedOrigins": "*" | [...], "requestSizeLimit": "1mb",
                "requestRateLimit": 10000 },
  // ... signingStore, networks, identityProviders, etc.
}
```

## Implications for our cutover

1. **`packages/sdk/src/settlement/adapters/amulet.ts` needs replacement, not just decoration**.
   It hits `/api/wallet-gateway/prepare-action` — this path is not part of the
   current API. Either it's a stale endpoint or a vendor-specific extension.
   The correct call shape is `sdk.prepareExecute({...})` via the dapp-sdk on
   the browser side, or `POST /api/v0/dapp` with method `prepareExecute` on
   the server side.

2. **SigningProvider interface needs five adapters**:
   - `ParticipantSigningProvider` (replaces our existing in-process Canton signing — production default)
   - `FireblocksSigningProvider`
   - `BlockdaemonSigningProvider`
   - `DfnsSigningProvider` ← **added**
   - `WalletGatewayInternalSigningProvider` (dev/test — replaces our `TestOnlyLocalSigningProvider` naming)

3. **Provider selection is per-party at creation time**, not per-deployment.
   Our config layer should let operators specify "which provider should this
   party use" rather than "global signing provider for this service."

4. **JSON-RPC 2.0 transport** changes how our SigningProvider adapter is
   structured. Each provider connects to a Wallet Gateway URL; the wire is
   JSON-RPC, not REST. Use the published `@canton-network/core-rpc-transport`
   if we want to share infrastructure with dapp-sdk.

5. **No in-process key handling at all in production**. The provider list
   verified: only the dev-only "Internal" provider stores keys directly in
   the Gateway's DB. Everything else delegates to participant/Fireblocks/
   Blockdaemon/Dfns. Our `hosted-wallet.ts` `signPreparedHash` (which calls
   `node:crypto`) does not have an analog in the documented architecture.

## Sources

- `docs/dapp-building/wallet-gateway/apis/index.md` — dApp + User API surface
- `docs/dapp-building/wallet-gateway/signing-providers/index.md` — all 5 providers
- `docs/dapp-building/wallet-gateway/configuration/schema.md` — config schema
- `api-specs/openrpc-dapp-api.json` — full OpenRPC spec (not fetched here; canonical source)
- `api-specs/openrpc-user-api.json` — User API OpenRPC spec

---

## Appendix — Legacy Validator-App `/api/wallet-gateway/*` Endpoints

> Verified via GitHub code search + Splice repo file-tree enumeration, May 2026.

### Question

Our existing `packages/sdk/src/settlement/adapters/amulet.ts` posts to
`POST /api/wallet-gateway/prepare-action` and `POST /api/wallet-gateway/execute-action`.
Comment at `amulet.ts:111` says "validator app exposing /api/wallet-gateway/*".
Is this a separate (operator-side) API that production traffic depends on,
or is it safe to delete in the cutover?

### Findings

1. **Zero hits in GitHub code search** for any of:
   - `"prepare-action"`
   - `"/api/wallet-gateway/prepare-action"`
   - `"api/wallet-gateway"`
2. **Zero file paths in the public Splice repo** (`hyperledger-labs/splice`, 12,502 entries searched recursively) contain `wallet-gateway`, `prepare-action`, or `execute-action`.
3. **The endpoint pattern is not in the canton-network or hyperledger-labs Canton repos** at all.
4. **Repository references**:
   - `packages/sdk/src/settlement/adapters/amulet.ts` — adapter implementation
   - `packages/proxy/src/host-wallet.ts` — proxy-side helpers
   - `packages/proxy/test/auto-withdraw.test.mjs` — tests against MOCKED endpoints (no real service)
   - `docs/DEPLOYMENT.md` — env-var documentation ("Base URL of the validator app exposing /api/wallet-gateway/*")
   - `docs/integration-guide/per-settlement-mode.md` — refers to the path
5. **`config/local.testnet.json` contains NO wallet-gateway URL** — no committed config points the probe at a real service of this shape.
6. **`docs/validation/` partner memos do not reference this surface.**

### Conclusion

The `/api/wallet-gateway/prepare-action` / `/execute-action` endpoint shape
is **not a documented public Canton / Splice API**. The most likely origins
are:

* A vendor-specific endpoint exposed by an earlier private prototype
* An older Splice Wallet Gateway pre-1.0 REST shape that was replaced by JSON-RPC 2.0
* A wrapper an unnamed validator partner stood up but never published

**No production traffic in our visible context depends on it.** Our tests
exercise the path against `https://wallet.example` mock servers; no probe
config points at it; no partner memo references it.

### Decision

* **Do NOT add a 6th `ValidatorAppAdapter`** to the SigningProvider list.
  The adapter list stays at 5 (Participant / Fireblocks / Blockdaemon /
  Dfns / WalletGatewayInternal).
* **Replace `amulet.ts` and `host-wallet.ts` entirely** with calls against
  the documented Splice Wallet Gateway JSON-RPC API. No deprecation window
  needed — the endpoint shape was never publicly contracted.
* **Migration note in code + docs**: when deleting `amulet.ts`, leave a
  `@deprecated` re-export pointing to the new SigningProvider for one
  minor version. Anyone with a private fork referencing it gets a clear
  signal.
* **Remove `CANTON_STREAMS_WALLET_GATEWAY_URL` from `docs/DEPLOYMENT.md`**
  and replace with the `SIGNING_PROVIDER` + Splice Wallet Gateway URL config.

Keep this note as historical context for why the public JSON-RPC gateway is
the only supported wallet-gateway integration path.
