# Canton Payment Streams

Payment streams for Canton, built on CIP-56 Token Standard V2.

Canton Payment Streams gives Canton dApps a reusable way to create, fund,
observe, and settle time-based payments. It ships Daml templates, a
TypeScript SDK, a REST proxy, an executor service, and a reference React
dashboard.

Use it when you want the ledger to carry both the payment schedule and the
settlement state: vesting, payroll-like payouts, subscriptions, incentive
programs, milestone payments, recurring treasury operations, and other
long-running payment flows.

Apache-2.0 licensed.

## Table Of Contents

- [Should I Use This?](#should-i-use-this)
- [What You Can Build](#what-you-can-build)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Wallets](#wallets)
- [Use The SDK](#use-the-sdk)
- [Integrate Into A Canton dApp](#integrate-into-a-canton-dapp)
- [Repository Map](#repository-map)
- [Development](#development)
- [Read Next](#read-next)

## Should I Use This?

Use Canton Payment Streams if you need a V2-token-standard payment flow where
funds unlock over time or according to an explicit event.

| If you need to... | Start with |
| --- | --- |
| Pay a fixed amount over a fixed schedule | `StreamAdmin` |
| Pay continuously with top-ups, pauses, or renewals | `StreamFlow` |
| Release tranches when milestones are confirmed | `MilestoneAdmin` |
| Let a bounded service execute recurring stream actions | `DelegatedPolicy` + executor |
| Create many streams from one operator workflow | Batch create |

This repo is a good fit when:

- You are building on Canton.
- Your asset supports CIP-56 Token Standard V2 allocation semantics.
- Your users can approve wallet actions through a CIP-103-compatible wallet.
- You want reusable contracts and SDK helpers instead of inventing a custom
  stream protocol.

This repo is not a good fit when:

- You need a wallet implementation. Bring a CIP-103 wallet; this repo is the
  dApp/protocol layer.
- You only need off-ledger bookkeeping.
- You need Token Standard V1 for new stream creation. New streams are V2-only.
- You want to depend on short-lived reward economics. Any featured-app reward
  support should be treated as optional and network-specific.

## What You Can Build

### Stream Variants

| Variant | What it does | Typical use |
| --- | --- | --- |
| `StreamAdmin` | Prefunded bounded stream with a start, end, and vesting mode | Vesting, subscriptions, scheduled payouts |
| `StreamFlow` | Rolling stream that can be topped up, paused, resumed, and renewed | Payroll-like flows, recurring incentives |
| `MilestoneAdmin` | Multi-leg release flow where named milestones unlock funds | Project delivery, KPI payouts, staged unlocks |

### Vesting Modes

| Mode | Behavior |
| --- | --- |
| `Linear` | Unlocks continuously between start and end. |
| `CliffLinear` | Unlocks nothing until the cliff, then unlocks linearly. |
| `Stepped` | Unlocks in discrete steps. |
| `RenewableTerm` | Unlocks within a term that can be renewed. |

Schedules can be short or long. Per-second and per-minute streams are valid as
long as the executor cadence, wallet approvals, and network costs make sense
for your deployment.

### Operational Features

- **Batch create:** upload or submit many stream definitions in one workflow.
- **Policies:** define bounded delegated execution rules on-ledger.
- **Executor:** run recurring settlement or policy-backed actions.
- **Inbox:** show receivers incoming streams truthfully; wallet approval still
  happens in the wallet.
- **Reference dashboard:** usable operator UI and integration example.

## How It Works

The core split is simple:

- Token custody lives in standard V2 allocation contracts.
- Streams templates record schedule, metadata, and settlement progress.
- Wallets sign standard V2 allocation actions.
- The executor settles each period with V2 settlement commands.
- The SDK/proxy/dashboard make this usable from TypeScript and the browser.

```text
dApp or dashboard
  -> CIP-103 wallet connection
  -> wallet approves V2 allocation
  -> Streams Daml templates record schedule and state
  -> executor calls V2 settlement over time
  -> SDK/proxy/dashboard query stream status
```

The important V2 commands are:

- `AllocationFactory_Allocate`
- `Allocation_Settle`
- `SettlementFactory_SettleBatch`

The project intentionally fails closed for unsupported legacy settlement paths
when creating new streams.

## Quick Start

### Prerequisites

- Node.js 22.14 or newer
- pnpm 9.15 via Corepack
- Docker with `docker compose`
- Daml/DPM 3.4.x if you are changing Daml packages
- A CIP-103 wallet gateway for live wallet-backed flows

Enable pnpm:

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

Install dependencies:

```bash
pnpm install
```

If your shell does not expose the `pnpm` shim, use `corepack pnpm` in the
commands below.

### Try The Local App Stack

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts:

| Service | URL / port |
| --- | --- |
| Dashboard | `http://localhost:3000` |
| REST proxy | `http://localhost:4000` |
| Canton participant gRPC | `localhost:5001` |
| Canton admin API | `localhost:5002` |

This local stack is useful for exploring the app shell, proxy, and contracts.
It does not start an Amulet wallet. For a real wallet-backed E2E run, use a
Splice LocalNet validator wallet and expose a CIP-103 dApp gateway at:

```text
http://localhost:3030/api/v0/dapp
```

For the full live-wallet flow, follow [docs/E2E-HARNESS.md](docs/E2E-HARNESS.md).

### Run The Dashboard And Proxy Without Docker

```bash
pnpm --filter @canton-streams/proxy dev
pnpm --filter @canton-streams/dashboard dev --host 127.0.0.1
```

Open `http://localhost:3000`.

### Connect Directly To A Local Wallet Gateway

Create `packages/dashboard/.env.local`:

```env
VITE_WALLET_LAYER=dapp-sdk
VITE_SKIP_WALLET_PICKER=true
VITE_WALLET_GATEWAY_URL=http://127.0.0.1:3030/api/v0/dapp
VITE_WALLET_NAME=Splice Amulet Wallet
```

With this mode enabled, the dashboard connects directly to the configured
remote wallet. If the gateway is unavailable, the UI shows a clear error
instead of opening a broken popup.

## Wallets

Canton Payment Streams supports two wallet layers through the same dashboard
contract.

| Layer | Best for | Notes |
| --- | --- | --- |
| `dapp-sdk` | LocalNet, Amulet, standards testing | Default. Connects to a CIP-103 wallet gateway. |
| `partylayer` | Hosted multi-wallet UX | Lets users choose wallets such as 5N Loop or Console through PartyLayer. |

For local standards testing, use the Splice Amulet wallet through a CIP-103
gateway. For hosted dApps, PartyLayer is the reference multi-wallet layer.

Hosted wallet approval is intentionally truthful: when the selected hosted
wallet does not expose automatic prepare-and-wait completion to the dashboard,
the user completes approval in the wallet UI and returns to Streams.

For live wallet validation, use [docs/E2E-HARNESS.md](docs/E2E-HARNESS.md).

## Use The SDK

Host applications can use the SDK without copying dashboard code.

```ts
import Decimal from 'decimal.js';
import { AssetType, SettlementMode, VestingMode } from '@canton-streams/sdk';

const stream = {
  sender: 'Alice::1220...',
  recipient: 'Bob::1220...',
  totalDeposited: new Decimal('100.00'),
  startTime: new Date('2026-07-01T00:00:00Z'),
  endTime: new Date('2026-08-01T00:00:00Z'),
  assetType: AssetType.GlobalCip56,
  settlementMode: SettlementMode.TokenStandardCustody,
  instrumentRef: {
    depository: 'AmuletAdmin::1220...',
    issuer: 'AmuletAdmin::1220...',
    instrumentId: 'CC',
    instrumentVersion: 'v2',
  },
  fundingReference: 'allocation-or-funding-ref-from-wallet',
  escrowOperator: 'Operator::1220...',
  senderAccount: { owner: 'Alice::1220...', id: 'default' },
  recipientAccount: { owner: 'Bob::1220...', id: 'default' },
  vestingMode: { mode: VestingMode.Linear },
  cancellable: true,
};
```

New stream creation requires V2 funding and account fields. Legacy settlement
names may still appear in read/migration types so older contracts can be
decoded, but they are not accepted for new V2 streams.

## Integrate Into A Canton dApp

Most dApps should start with the SDK + proxy path:

1. Upload and vet the Streams DAR on the participant/synchronizer used by your
   app.
2. Run the Streams proxy and executor next to your app backend.
3. Connect the user's CIP-103 wallet in your frontend.
4. Collect recipient, token, amount, start/end, and vesting schedule.
5. Create the stream metadata and ask the wallet to approve the V2 allocation.
6. Show stream state from SDK/proxy queries.
7. Let the executor settle accrual periods.

End-user flow:

```text
Connect wallet
  -> choose or confirm account
  -> create stream
  -> approve V2 allocation in wallet
  -> sender sees active stream
  -> receiver sees incoming stream
  -> executor settles over time
```

What this repo provides vs. what your dApp owns:

| Provided here | Owned by your dApp |
| --- | --- |
| Daml stream/admin templates | Product-specific UX and copy |
| TypeScript SDK and validation | Business rules and recipient selection |
| REST proxy | App auth/session model |
| Executor service | Deployment, monitoring, and operations |
| Reference dashboard | Final branded frontend, if different |
| Local runbooks | Production infrastructure choices |

## Repository Map

| Path | Purpose |
| --- | --- |
| `packages/daml/` | Daml templates, interfaces, and tests |
| `packages/sdk/` | TypeScript SDK, V2 helpers, validation, transports |
| `packages/proxy/` | Express REST proxy and settlement/event workers |
| `packages/dashboard/` | React reference UI with wallet integration |
| `packages/cli/` | Operator CLI |
| `packages/executor/` | Delegated execution service |
| `docker/` | Local app stack |
| `docs/` | Guides, architecture, deployment, runbooks, threat model |

## Development

Run the main checks:

```bash
pnpm --filter @canton-streams/sdk test
pnpm --filter @canton-streams/dashboard test
pnpm --filter @canton-streams/proxy build
pnpm --filter @canton-streams/dashboard build
bash scripts/check-v2-conformance.sh
docker compose -f docker/docker-compose.yml config
```

Daml:

```bash
pnpm daml:deps
pnpm daml:build
pnpm daml:test
```

Note: the Daml script package includes example scripts that require real party
identifiers. If you run all scripts against placeholder parties, those example
scripts will fail until you replace the placeholders with parties from your
participant.

## Read Next

| If you want to... | Read |
| --- | --- |
| Run locally | [docs/QUICKSTART.md](docs/QUICKSTART.md) |
| Test with a real wallet | [docs/E2E-HARNESS.md](docs/E2E-HARNESS.md) |
| Integrate into your dApp | [docs/integration-guide/README.md](docs/integration-guide/README.md) |
| Understand the architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Deploy safely | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Operate in production | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| Review risks | [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) |
| See findings and their fixes | [docs/SECURITY-FINDINGS.md](docs/SECURITY-FINDINGS.md) |
| Scope an independent review | [docs/AUDIT-SCOPE.md](docs/AUDIT-SCOPE.md) |
| Cut a release candidate | [docs/RELEASE-CANDIDATE.md](docs/RELEASE-CANDIDATE.md) |
| Check REST endpoints | [docs/API.md](docs/API.md) |
| Know what's supported | [docs/SUPPORT.md](docs/SUPPORT.md) |

## Contributing

Contributions are welcome. Start with:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

For a first PR, prefer a small change with a clear test. Good starter areas
are documentation clarity, SDK validation tests, dashboard copy, and local
runbook improvements.

## License

[Apache 2.0](LICENSE)
