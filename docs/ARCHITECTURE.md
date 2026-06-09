# Architecture

## System overview

```
+------------------+     +------------------+     +--------------------+
|   Dashboard      |     |   REST Proxy     |     |  Canton Ledger     |
|   (React / Vite) |---->|   (Express)      |---->|  (Daml Runtime)    |
|   :3000          |     |   :4000          |     |  gRPC :5001        |
+--------+---------+     +--------+---------+     |  JSON API :7575    |
         |                        |                |  Admin :5002       |
         | CIP-103 dapp-sdk       |                +---------+----------+
         v                        v                          |
+------------------+     +------------------+                v
|  Wallet Gateway  |     |   SDK            |        +--------------+
|  (Splice Wallet  |     |   (TypeScript)   |        | Daml Templates|
|   Kernel, etc.)  |     +--------+---------+        | + V2 packages |
|  :3030           |              |                  +--------------+
+--------+---------+              |
         |                        |
         +------- signs ----------+----- queries / submits ----------+
                                  v                                    v
                          +------------------+              +-------------------+
                          | TransferEventsV2 |              | AllocationRequest |
                          | subscriber       |              | dual-interface    |
                          | (proxy)          |              | (V1 + V2)         |
                          +------------------+              +-------------------+
```

Two transport paths from the dashboard:

1. **Browser-direct via CIP-103 wallet** (default for end-user actions) — Dashboard → `@canton-network/dapp-sdk` → wallet gateway → ledger. Reads use `dappSDK.ledgerApi(...)`, writes use `dappSDK.prepareExecute(...)`. No proxy in the hot path.
2. **REST proxy** (for server-side automation + reads that benefit from caching) — Dashboard → `/api/streams` → proxy → SDK (gRPC) → ledger.

The proxy adds JWT auth, CORS, the `TransferEventsV2` auto-withdraw subscriber, and adoption-metrics aggregation. Browser writes do not require the proxy.

## Packages

### `packages/daml/` — Daml templates

Compiled to DARs and uploaded to the participant.

| Template | Module | Role |
|---|---|---|
| `StreamAdmin` | `CantonStreams.Stream.StreamAdmin` | Prefunded, bounded-term stream (V2 committed-iterated drive) |
| `StreamFlow` + `StreamFlowAdmin` | `CantonStreams.Stream.StreamFlow*` | Iterated stream with variable funding (subscriptions, recurring billing) |
| `MilestoneAdmin` | `CantonStreams.Stream.MilestoneAdmin` | Multi-leg AllocationSpec gated on `ConfirmMilestone` (KPI or delivery unlocks) |
| `AllocationBridge` | `CantonStreams.Settlement.AllocationBridge` | Shared V2 view-builder helpers + conservation invariants |
| `DelegatedPolicy` + `PolicyExecutionState` + `ExecutionLog` | `CantonStreams.Policy.*` | Bounded executor authority (rate limit, expiry, scope, action allow-list) |
| `FeaturedAppActivity` | `CantonStreams.FeaturedApp.Activity` | Opt-in CIP-0047 `FeaturedAppActivityMarker` emission helper for networks that still support the marker path |
| `UnifiedStreamRequest` | `CantonStreams.Workflow.UnifiedStream` | Propose / accept / counter-propose state machine |
| `BatchCreateRequest` | `CantonStreams.Workflow.BatchCreate` | Sender-side bulk stream creation |
| `RenewRequest` | `CantonStreams.Workflow.RenewStream` | Per-period renewal for `RenewableTerm` vesting |

Stream-admin templates expose the V2 `AllocationRequest` shape only. Per CIP-0112 §5, V1 assets are expected to publish V2 interfaces alongside V1; this library integrates once the asset advertises the required V2 capabilities.

### `packages/sdk/` — TypeScript SDK

Browser-safe via `@canton-streams/sdk/browser` (excludes Node-only deps like gRPC + pino).

| Surface | Purpose |
|---|---|
| `CantonStreamsClient` | High-level API: create / accept / withdraw / cancel / renew / query (server-side) |
| `buildAllocationRequest` | Construct a V2 `AllocationRequest` for dispatch via `dappSDK.prepareExecute` (browser-side) |
| `GrpcTransport` / `JsonApiTransport` | Interchangeable transports |
| `BalanceTicker` | Client-side accrual display |
| Accrual functions | `linearAccrual`, `cliffLinearAccrual`, `steppedAccrual`, `renewableTermAccrual` |
| `getAssetCapabilities(instrumentRef)` | Runtime CIP-0112 capability gate; library rejects assets that lack required V2 allocation support |
| Asset registry loader | Reads `config/asset-registry.json` for per-asset admin / Scan / wallet-gateway routing |

### `packages/proxy/` — REST proxy

Express server with:
1. JWT auth (production) or dev bypass (`PROXY_AUTH_MODE=dev`)
2. REST endpoints → SDK client calls
3. Per-action role enforcement (sender / recipient / operator)
4. `TransferEventsV2` subscriber (`transfer-events-subscriber.ts`) for event-driven auto-withdraw
5. Interactive-submission path for externally-keyed escrow operators

Identity is read from the JWT `party` (or `sub`) claim. The proxy does **not** require the `X-Canton-Party` header from browser callers (legacy header support remains for older scripts).

### `packages/dashboard/` — React SPA

Vite + React 19 + Tailwind 4 + TanStack Query + react-router 7 + Radix UI + react-hook-form + zod.

Auth state is backed by `@canton-network/dapp-sdk`:
- `dappSDK.init()` on mount → status restoration
- `dappSDK.connect()` on Connect Wallet click → opens CIP-103 wallet picker
- `dappSDK.listAccounts()` populates the connected-party context
- `dappSDK.onStatusChanged()` / `onAccountsChanged()` keeps the UI in sync

Dev fallback: JWT-paste in sessionStorage (intended for local proxy use only).

### `packages/cli/` — Operator CLI

`canton-streams` binary for batch operations, adoption-metrics queries, and DAR vetting helpers.

### `packages/executor/` — Bounded automation runner

Runs `DelegatedPolicy` execution against the on-ledger bounds (rate limit, expiry, scope, action allow-list, cooldown). Useful for trust-minimized recurring withdrawals on behalf of recipients.

## Settlement: CIP-56 V2 + CIP-0112 Capability Gate

There is one settlement path: **CIP-56 V2 Token Standard** via the CIP-0112 `AllocationRequest` pattern. The legacy V0/V1 paths from earlier releases (Utility holding, NumericLegacy, LocalAsset, hosted wallet-gateway settlement-reference) have been removed.

### Capability negotiation flow

1. dApp picks the asset by `instrumentRef` (e.g. `{ instrumentId: 'CC', admin: 'CCAdmin::1220...' }`)
2. SDK calls `getAssetCapabilities(instrumentRef)` against `config/asset-registry.json`
3. Registry entry advertises which interfaces the asset implements:
   ```jsonc
   {
     "allocationsV2": true,     // required: V2 allocation support
     "transferEventsV2": true   // preferred: V2 events stream available
   }
   ```
4. Library accepts the asset only when `allocationsV2 = true`. If `transferEventsV2 = true`, the proxy uses the V2 event stream; otherwise the raw Ledger API V2 fallback provides compatibility coverage while assets adopt V2 event interfaces.

When an asset is upgraded to advertise V2 interfaces (e.g. when CC or USDCx publish them), only the registry entry needs to change — application code keeps working and benefits from V2 features.

### Per-asset routing

| Field | Why |
|---|---|
| `admin` | Instrument admin party (signs admin choices) |
| `scanEndpoint` | The Super Validator's Scan API for adoption metrics |
| `walletGatewayUrl` | Where the SDK sends prepare/execute calls for browser-side signing |
| `synchronizerId` | (Optional) override which synchronizer the stream is created on |

The same SDK call shape works for CC, USDCx, and any future CIP-56 asset. Adopters do not branch on asset name.

## Data flow: create → accept → settle (StreamAdmin)

```
1. Sender constructs an AllocationRequest
   Dashboard -> @canton-streams/sdk: buildAllocationRequest({ ... })
     -> returns { commands: [...], summary: {...} }

2. Sender's wallet signs + submits
   Dashboard -> dappSDK.prepareExecute({ commands, actAs: [sender] })
     -> wallet gateway prepares + signs + submits
     <- AllocationRequest contract on-ledger, observable by recipient

3. Recipient sees the request in their wallet's inbox
   Dashboard -> dappSDK.listAccounts() -> filter for pending requests
     -> recipient clicks Accept

4. Recipient's wallet exercises AllocationRequest_Accept
   Recipient wallet -> exercise AllocationRequest_Accept
     -> creates the Allocation contract, sender's funding locks atomically
     -> AllocationRequest archived

5. Per accrual interval, proxy executes the next leg
   Proxy auto-withdraw worker -> exercise Allocation_Settle
     -> funds flow sender -> recipient for that leg
     -> Allocation rolls forward with nextIterationFunding
     -> TransferEventsV2 emitted, subscriber advances stream state

6. After final iteration, stream completes
   Allocation_Settle with no nextIterationFunding
     -> Allocation archived, stream marked Completed
```

`StreamFlow` is the same shape with iterated allocations and sender-side `TopUp` between iterations. `MilestoneAdmin` is a single multi-leg `AllocationSpec` where each leg is gated on a `ConfirmMilestone` from the admin party.

## Trust boundary

| Component | Trust | Why |
|---|---|---|
| On-ledger Daml templates | Daml authority model | Templates enforce invariants (conservation, sender/recipient signatures, executor bounds) |
| Wallet gateway | User trusts their chosen wallet | CIP-103 wallets sign on the user's behalf with their consent |
| REST proxy | Service principal, least-privilege | Proxy must NOT be given a participant-admin token; provision a dedicated service user with `CanReadAsAnyParty` + `CanActAs` on the escrow operator only |
| `DelegatedPolicy` executor | Bounded on-chain | Rate limits, expiry, scope, action allow-list, cooldown enforced by `ExecutePolicy` choice |

See [THREAT-MODEL.md](THREAT-MODEL.md) for the full threat analysis.

## Configuration

| Config | Source | Purpose |
|---|---|---|
| `config/asset-registry.json` | In-repo, public | Per-asset admin / Scan / wallet-gateway routing, V2 capability flags |
| Proxy env vars | `.env` or runtime env | `CANTON_HOST/PORT`, `CANTON_JSON_API_URL`, `CANTON_SYNCHRONIZER_ID`, `CANTON_STREAMS_PACKAGE_ID`, `PROXY_AUTH_MODE`, `PROXY_SERVICE_TOKEN`, etc. |
| Dashboard env vars | `packages/dashboard/.env.local` (gitignored) | `VITE_SKIP_WALLET_PICKER`, `VITE_WALLET_GATEWAY_URL`, `VITE_WC_PROJECT_ID` |
| Local-deployment metadata | `config/local.<env>.json` (gitignored) | Per-environment party ids, package ids, contract ids for sandbox debug scripts |

Templates live next to the gitignored counterparts (`config/local.testnet.example.json`, `packages/dashboard/.env.example`) and ship with the repo.

## Versioning

- Workspace packages and the main Daml DAR share a release line (currently `0.2.8` for the DAR, `0.2.7` for the npm packages — alignment lands in the next release).
- DAR filenames are `canton-streams-<version>.dar`.
- See [RELEASING.md](../RELEASING.md) for the tag-driven npm release process.
