# Canton Payment Streams

Continuous, vesting-aware payment streaming for [Canton](https://www.canton.network/) — Daml smart-contract templates, a TypeScript SDK, a REST proxy, and a React reference dashboard.

Canton Payment Streams lets a sender and a recipient agree, on-ledger, to a time-locked vesting schedule that the recipient can draw down as funds accrue. Streams support linear, cliff, stepped, and milestone-gated schedules; cancellation, mutual cancellation, and renewal flows; and recurring top-up ("flow") subscriptions for usage-shaped relationships.

The current release is **V2-only**: every settlement path is the CIP-56 V2 Token Standard via the CIP-0112 `AllocationRequest` pattern. End-user wallet authentication uses [CIP-103](https://github.com/canton-foundation/cips/blob/main/cip-0103/cip-0103.md) via the [Splice Wallet Kernel](https://github.com/canton-network/splice-wallet-kernel) (or any other CIP-103-compliant wallet gateway).

## Packages

| Package | Path | Description |
|---|---|---|
| **Daml templates** | `packages/daml/` | On-ledger stream admin contracts, workflow templates, and the V1/V2 `AllocationBridge` view helpers |
| **SDK** | `packages/sdk/` | TypeScript client library (gRPC + JSON API transports, V2 capability negotiation) |
| **Proxy** | `packages/proxy/` | Express REST proxy with JWT auth and a `TransferEventsV2` settlement subscriber |
| **Dashboard** | `packages/dashboard/` | React + Vite reference UI, wired to `@canton-network/dapp-sdk` (CIP-103 wallet flow) |
| **CLI** | `packages/cli/` | Operator command-line tool for batch operations and adoption metrics |
| **Executor** | `packages/executor/` | Bounded automation runner for `DelegatedPolicy` execution |

## Quick start

```bash
# Prerequisites: Node >= 22.14, pnpm >= 9.15, Docker, Daml SDK 3.4.10

# Clone and install
git clone git@github.com:deepthi-2531/Payment-Streams.git
cd Payment-Streams
pnpm install

# Build all packages
pnpm build

# Start Canton sandbox + dashboard via docker-compose
docker compose -f docker/docker-compose.yml up -d

# Or for local development (sandbox separately — see docs/DEPLOYMENT.md)
pnpm dev          # starts proxy + dashboard in watch mode
```

Open [http://localhost:3000](http://localhost:3000), click **Connect wallet**, complete the CIP-103 wallet flow, and the dashboard takes you to the stream list.

See [docs/QUICKSTART.md](docs/QUICKSTART.md) for the step-by-step walkthrough including a sample stream lifecycle.

## What ships

### Settlement

A single, unified settlement path: **CIP-56 V2 Token Standard** via CIP-0112 `AllocationRequest`. The SDK negotiates V1/V2 capability per asset at runtime via `getAssetCapabilities(instrumentRef)`; assets that advertise V2 use multi-leg allocations, batch settlement, lock-in-place custody, and `TransferEventsV2` event-driven advancement. The same code path serves Canton Coin, USDCx, and any other CIP-56 asset.

The legacy `NumericLegacy`, `UtilityHoldingCustody`, `LocalAssetCustody`, and `Delegated` settlement modes from earlier releases have been removed. The `SettlementMode` enum in the SDK retains the names for backwards compatibility with persisted requests but the only mode accepted by the live code path is `TokenStandardCustody`.

### Stream variants (Daml templates)

| Variant | Daml template | Use case |
|---|---|---|
| **Prefunded, bounded-term** | `Stream.StreamAdmin` | Vesting, LP incentive emissions, treasury distributions |
| **Iterated, variable funding** | `Stream.StreamFlow` + `Stream.StreamFlowAdmin` | Open-ended subscriptions, recurring billing, usage-shaped flows |
| **Event-triggered tranches** | `Stream.MilestoneAdmin` | KPI-gated unlocks, grant disbursements, milestone-based releases |

All three drive on-ledger via the V2 `AllocationFactory_Allocate` / `Allocation_ExecuteTransfer` chain through the shared `Settlement.AllocationBridge` helpers.

### Vesting modes

| Mode | Description |
|---|---|
| `Linear` | Constant rate from start to end |
| `CliffLinear` | Zero before the cliff; linear after |
| `Stepped` | Discrete tranches at named milestones |
| `RenewableTerm` | Auto-renewing fixed-term periods |

### Wallet & auth model

End-user actions use the **CIP-103 wallet flow** through `@canton-network/dapp-sdk`. The dashboard renders a wallet picker, the user selects their wallet (default: a CIP-103 remote wallet like the Splice Wallet Kernel), and all sign-required operations dispatch through `dappSDK.prepareExecute(...)`.

Server-side automation (auto-withdraw, scheduled finalize) uses the **REST proxy** with a JWT bearer token. The proxy reads identity from the JWT `party` (or `sub`) claim; it does **not** require a separate `X-Canton-Party` header. Set `VITE_SKIP_WALLET_PICKER=true` in `packages/dashboard/.env.local` for local development convenience (auto-selects the configured remote wallet without showing the picker UI).

## Automation Architecture

A streaming-payment protocol is only half the picture. Every real deployment also needs **automation**: someone has to drive `Allocation_ExecuteTransfer` per accrual interval, settle milestone legs when KPIs hit, top up subscription funding, retry failed transfers, claim inbound payouts. If that automation is designed off-chain after the templates are frozen, two things go wrong: (1) the templates miss the hooks the automation needs, and (2) each adopter reinvents the authorization story, usually badly.

We treat automation as a first-class, **co-designed** part of the system and ship it alongside the on-ledger contracts. The commitment lives in four layers:

### Layer 1 — On-ledger authorization primitive (`DelegatedPolicy`)

`packages/daml/main/daml/CantonStreams/Policy/DelegatedPolicy.daml` is the contract that bounds automation **on the ledger itself**. It is signed by sender + recipient + executor, and the `ExecutePolicy` choice enforces every bound atomically:

| Bound | Purpose |
|---|---|
| `expiresAt` | Hard time cap on the executor's authority |
| `active` (`RevokePolicy` choice) | Sender can revoke unilaterally at any time |
| `allowedActions: [DelegatedAction]` | Whitelist of choice names (`Withdraw`, `Cancel`, `Renew`, …) |
| `streamFilters: [Text]` | Scope to specific streams |
| `rateLimit.maxExecutionsPerPeriod` | "no more than N withdraws per hour" |
| `rateLimit.maxAmountPerExecution` | "no more than X per call" |
| `rateLimit.cooldownInterval` | Minimum gap between calls |

Every execution also creates an **append-only `ExecutionLog`** contract, so the audit trail is on-chain and tamper-evident — not a JSON file on the operator's box.

This is the answer to *"automation needs authorization"*: the authorization is part of the same Daml authority model as the streams themselves. There is no off-chain ACL.

### Layer 2 — Named automation parties in the stream templates

The stream-admin templates have the off-chain automation party **baked in** as a typed field, not assumed:

| Template | Automation party | What it does |
|---|---|---|
| `StreamAdmin` | `escrowOperator` | Drives `Allocation_ExecuteTransfer` per accrual interval |
| `StreamFlow` + `StreamFlowAdmin` | `escrowOperator` | Same, plus handles `TopUp` / `Pause` / `Resume` / `Stop` |
| `MilestoneAdmin` | `confirmer` | Confirms named milestones via `ConfirmMilestone`; can be the sender (self-confirmed grants), an oracle, or a KPI validator |
| `DelegatedPolicy` | `executor` | Runs bounded automation under the policy |

Because the automation party is on-ledger, its signature is required for the operations it performs, and the Daml authority model decides what it can and cannot do. The templates were designed around this — they are not generic stream contracts retrofitted with an operator field.

### Layer 3 — Reference automation runtimes

Adopters don't write the common automation from scratch. Three runtimes ship in the same release:

| Package | Role |
|---|---|
| `packages/proxy/src/transfer-events-subscriber.ts` | Event-driven advancement. Subscribes to `TransferEventsV2` and exercises `Allocation_ExecuteTransfer` on the next leg when a settle event arrives. Replaces the old poll-based auto-withdraw. |
| `packages/executor/` | Bounded executor that consumes `DelegatedPolicy` contracts and runs within their on-ledger bounds. Reusable as-is or as a reference. |
| `packages/proxy/src/auto-withdraw.ts` | Interactive-submission path for participants where direct gRPC submission isn't viable for the escrow operator. |

The proxy + executor are bundled with the SDK + Daml templates in one monorepo, one versioned release line. Adopters can use them directly, fork them, or replace them — but they don't start from a blank page.

### Layer 4 — Common operator workflows in the CLI

`packages/cli/` ships `canton-streams` for batch stream creation, adoption-metrics aggregation, DAR vetting verification, and policy execution. `scripts/provision-streams-service.mjs` provisions a least-privilege service principal (`CanReadAsAnyParty + CanActAs` only for the escrow operator) so adopters don't accidentally hand an admin token to the automation.

### Why this matters

The reviewer concern this section answers: *"automation will need authorization and common logic, and its design will influence the payment streams. You have to design/build the other part at the same time."*

Our commitment:

1. **Automation parties are on-ledger fields** in the stream templates — not assumed, not off-chain.
2. **Authorization is a Daml contract** (`DelegatedPolicy`), not an off-chain config — same authority model as the streams themselves.
3. **Reference runtimes ship in the same release** — adopters don't reinvent auto-withdraw, milestone confirmation, or the executor loop.
4. **Audit is on-chain** (`ExecutionLog`) — tamper-evident, queryable, jurisdiction-portable.
5. **Operator workflows are scripted** — `provision-streams-service.mjs`, the CLI, the proxy readiness checks — so adopters land in a known-good production posture.

For the concrete walkthrough of how all four layers interact in a real integration, see [INTEGRATION-EXAMPLE.md § "Trust-minimized executor"](docs/INTEGRATION-EXAMPLE.md#trust-minimized-executor) and [WALKTHROUGHS.md](docs/WALKTHROUGHS.md).

## Integrating into another Canton app

The integration boundary is:

- Canton Payment Streams owns the on-ledger stream contracts, the proxy, the SDK, and the reference dashboard.
- Your app owns user onboarding, the wallet UX, asset-account configuration, and any app-specific business logic on top of stream events.

### 1. Choose the stream variant

| Use case | Template |
|---|---|
| Vesting / LP rewards / treasury distribution (bounded term, prefunded) | `StreamAdmin` |
| Subscription / metered billing / open-ended retainer | `StreamFlow` + `StreamFlowAdmin` |
| Grant disbursement / KPI-gated unlock / milestone payment | `MilestoneAdmin` |

All three settle via the same V2 `AllocationRequest` path, so wallet integration is identical.

### 2. Deploy and vet the canton-streams DAR

```bash
pnpm daml:deps                  # fetch Splice V2 dependency DARs
pnpm daml:build                 # compile to packages/daml/main/.daml/dist/canton-streams-0.2.8.dar
daml ledger upload-dar          # upload to your participant
                                # then vet on the synchronizer (see docs/DEPLOYMENT.md)
```

A DAR being uploaded is not the same as being vetted. The proxy's startup readiness checks (enabled with `PROXY_STARTUP_REQUIRE_VETTED_PACKAGES=1`) catch the difference before users hit the flow.

### 3. Provision the minimum identities

| Actor | What it is | Why it exists |
|---|---|---|
| Sender | End-user party | Creates and funds the stream |
| Recipient | End-user party | Accepts the stream and receives payouts |
| Escrow operator | Dedicated service-owned party | Holds and forwards funds during the stream lifecycle |
| Service principal | Dedicated ledger user / JWT for the proxy | Reads ledger state, submits service-owned commands |

Recommended: a dedicated `Streams-Escrow` party, a dedicated service user/token (least-privilege: `CanReadAsAnyParty` plus `CanActAs` only for the escrow operator), and never reuse a broad app admin JWT for the proxy.

```bash
node scripts/provision-streams-service.mjs \
  --api-url http://<your-validator>:7575 \
  --admin-token "$PARTICIPANT_ADMIN_TOKEN" \
  --user-id streams-service \
  --primary-party "$PROXY_ESCROW_OPERATOR" \
  --grant-read-as-any-party \
  --act-as "$PROXY_ESCROW_OPERATOR"
```

### 4. Register your assets

Per-asset routing lives in `config/asset-registry.json`. Each entry maps an asset to its admin party, Scan endpoint, wallet-gateway URL, and the V1/V2 capability flags the SDK uses to pick the right adapter at runtime.

```jsonc
{
  "assets": [
    {
      "id": "MyAsset",
      "admin": "MyAssetAdmin::1220...",
      "scanEndpoint": "https://scan.example.com",
      "walletGatewayUrl": "https://wallet.example.com/api/v0/dapp",
      "capabilities": {
        "transfersV1": true,
        "transfersV2": true,
        "allocationsV2": true,
        "transferEventsV2": true
      }
    }
  ]
}
```

The SDK call `getAssetCapabilities('MyAsset')` reads this registry and the library picks the right V1/V2 adapter per CIP-0112 automatically. When an asset is upgraded from V1 to V2, only the registry entry needs to change — no application code changes.

### 5. Configure the proxy for production

Required environment variables:

| Variable | Purpose |
|---|---|
| `CANTON_HOST` / `CANTON_PORT` | gRPC ledger API endpoint (default `localhost:5001`) |
| `CANTON_JSON_API_URL` | JSON API base URL (default `http://localhost:7575`) |
| `CANTON_SYNCHRONIZER_ID` | Synchronizer the streams DAR is vetted on |
| `CANTON_STREAMS_PACKAGE_ID` | Package id of the deployed `canton-streams` DAR |
| `PROXY_PORT` | Port for the proxy to listen on (default `4000`) |
| `PROXY_AUTH_MODE` | `jwt` (production) or `dev` (local) |
| `PROXY_SERVICE_TOKEN` | Service JWT for finalize / auto-withdraw routes |
| `PROXY_ESCROW_OPERATOR` | The escrow-operator party id |
| `ALLOWED_ORIGINS` | CORS allowlist (e.g. `http://localhost:3000` for local dashboard) |
| `PROXY_STARTUP_REQUIRE_VETTED_PACKAGES` | `1` to fail fast on un-vetted DAR |

For event-driven auto-withdraw via `TransferEventsV2`:

| Variable | Purpose |
|---|---|
| `PROXY_TRANSFER_EVENTS_ENABLED` | `1` to enable the V2 events subscriber |
| `PROXY_SERVICE_USER_ID` | Ledger user id for interactive submission |

The full environment-variable matrix lives in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### 6. End-to-end lifecycle the host app must support

For a real `StreamAdmin` (prefunded) stream:

1. Sender constructs an `AllocationRequest` via the SDK and dispatches the create through `dappSDK.prepareExecute(...)`.
2. Recipient sees the request in their wallet and accepts.
3. Sender's wallet signs the funding `AllocationFactory_Allocate(committed=True, ...)` — funds lock against the escrow.
4. On each accrual interval, the proxy (or operator CLI) issues `Allocation_ExecuteTransfer` for that period's leg — funds flow to the recipient.
5. After the final iteration, the stream completes.

`StreamFlow` follows the same shape but uses iterated allocations with `nextIterationFunding`, allowing sender top-ups between iterations. `MilestoneAdmin` uses multi-leg allocations where each leg is gated on a `ConfirmMilestone` choice.

### 7. What "working end-to-end" means

Don't call an integration complete until all of the following are true:

- Stream `AllocationRequest` is visible to the recipient's wallet
- Recipient accepts and the request becomes a live `Allocation`
- Sender's funding transfer settles atomically with the accept (V2-committed)
- Recurring `Allocation_ExecuteTransfer` calls advance on schedule
- Recipient's holding balance increases after each settle
- Stream state advances correctly (`totalWithdrawn`, `escrowAmount`, `numIterations`)

The cadence the user observes is bounded by the host wallet's settlement latency. The Daml accrual math is exact; the wall-clock cadence depends on how fast `prepare → sign → submit` round-trips for the relevant party.

### 8. Reference integration examples

Two worked examples in [docs/INTEGRATION-EXAMPLE.md](docs/INTEGRATION-EXAMPLE.md):

- **CC / Amulet** — native Canton Coin streaming via the Splice token-standard interfaces. The probe `scripts/testnet-cc-stream-probe.mjs` exercises the path end-to-end against a real validator.
- **USDCx** — DA Utility hosted asset via wallet-gateway flow. The probe `scripts/testnet-usdcx-stream-probe.mjs` runs the same against USDCx.

Both probes use exactly the same SDK call shape; only the asset registry entry differs.

## Documentation

| Doc | When to read |
|---|---|
| [QUICKSTART](docs/QUICKSTART.md) | First-time setup — sandbox + dashboard + first stream |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | System design — packages, data flow, V2 capability negotiation |
| [API](docs/API.md) | REST proxy endpoint reference |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Production deployment — env vars, DAR upload + vetting |
| [OPERATIONS](docs/OPERATIONS.md) | Day-2 ops — monitoring, troubleshooting, DAR upgrades |
| [TESTNET-RUNBOOK](docs/TESTNET-RUNBOOK.md) | Bring the proxy + dashboard up against a remote validator |
| [SWK-WALLET-RUNBOOK](docs/SWK-WALLET-RUNBOOK.md) | Wire the dashboard to a local Splice Wallet Kernel |
| [INTEGRATION-EXAMPLE](docs/INTEGRATION-EXAMPLE.md) | Concrete host-app integration walkthrough |
| [WALKTHROUGHS](docs/WALKTHROUGHS.md) | Annotated stream lifecycle traces |
| [THREAT-MODEL](docs/THREAT-MODEL.md) | Security boundaries, trust assumptions, mitigations |
| [BENCHMARKS](docs/BENCHMARKS.md) | Latency, throughput, fee burn per lifecycle |
| [MAINTENANCE](docs/MAINTENANCE.md) | Support window, security patch SLA |
| [integration-guide/](docs/integration-guide/) | CIP-103 walkthrough, CIP-56 V2 type reference, per-asset config, wallet-gateway API reference |

## SDK usage

```typescript
import { dappSDK } from '@canton-network/dapp-sdk';
import {
  buildAllocationRequest,
  VestingMode,
  SettlementMode,
} from '@canton-streams/sdk';
import Decimal from 'decimal.js';

// 1. Connect wallet (CIP-103)
await dappSDK.init();
await dappSDK.connect();
const accounts = await dappSDK.listAccounts();
const sender = accounts.find((a) => a.primary)!.partyId;

// 2. Construct a V2 AllocationRequest for a 1000-unit linear stream
const request = buildAllocationRequest({
  sender,
  recipient: 'Bob::1220...',
  asset: { instrumentId: 'MyAsset', admin: 'MyAssetAdmin::1220...' },
  totalAmount: new Decimal('1000'),
  vestingMode: { mode: VestingMode.Linear },
  startTime: new Date(),
  endTime: new Date(Date.now() + 86_400_000), // 24 hours
  settlementMode: SettlementMode.TokenStandardCustody,
});

// 3. Dispatch via the wallet (sender signs, ledger commits)
const { txId } = await dappSDK.prepareExecuteAndWait({
  commands: request.commands,
  actAs: [sender],
});

console.log(`Stream created: ${txId}`);
```

For server-side automation (no browser wallet), use `CantonStreamsClient` from `@canton-streams/sdk` directly with a service JWT — see [docs/API.md](docs/API.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow, prerequisites, and code conventions. Security issues: see [SECURITY.md](SECURITY.md). All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE)
