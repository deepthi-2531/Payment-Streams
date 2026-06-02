# Canton Payment Streams

Payment streams for Canton, built around the CIP-56 V2 Token Standard.

This repository contains Daml templates, a TypeScript SDK, a REST proxy, a CLI,
and a reference React dashboard for creating and operating vesting-aware payment
streams on Canton.

It is Apache-2.0 licensed.

## Start Here

### Should I use this?

Use Canton Payment Streams if you need one of these product shapes:

| Need                                        | Use               |
| ------------------------------------------- | ----------------- |
| Pay a fixed amount over time                | `StreamAdmin`     |
| Pay in periods with renewals or top-ups     | `StreamFlow`      |
| Release funds when milestones are confirmed | `MilestoneAdmin`  |
| Let a bounded service run recurring actions | `DelegatedPolicy` |

This is a good fit for vesting, payroll-like distributions, LP incentives,
subscription-style settlement, treasury grants, milestone payments, and other
flows where the ledger should show both the schedule and the settlement state.

### When should I not use it?

Do not use this repo if you need:

- A wallet implementation. Use a CIP-103 wallet such as the Splice Amulet wallet.
- Off-ledger bookkeeping only.
- Token Standard V1 or legacy settlement. New stream creation is V2-only.
- A promise about CIP-0047 rewards or economics. CIP-0047 support is transitional
  and should not be used as a fixed revenue assumption.

## Current Status

| Area             | Status                                               |
| ---------------- | ---------------------------------------------------- |
| Token standard   | CIP-56 V2 / CIP-0112 only for new streams            |
| Wallet path      | CIP-103 via `@canton-network/dapp-sdk`               |
| Reference wallet | Splice Amulet wallet on `token-standard-v2-upcoming` |
| Local app stack  | Docker starts Canton, proxy, and dashboard           |
| Full wallet E2E  | Requires a separate Splice LocalNet validator wallet |
| Legacy modes     | Kept only for parsing/migration compatibility        |

The code intentionally fails closed when a new stream tries to use
`NumericLegacy`, `UtilityHoldingCustody`, or missing V2 funding/account fields.

## How It Works

The minimal happy path is:

```text
User in dashboard
  -> CIP-103 wallet connection through @canton-network/dapp-sdk
  -> Amulet wallet signs the V2 allocation flow
  -> StreamAdmin records stream metadata and allocation references
  -> proxy/executor drives V2 settlement over time
  -> dashboard and SDK query stream state
```

The important design split:

- Token custody lives in standard V2 allocation contracts.
- Stream templates record stream metadata, vesting state, and observability.
- The wallet signs standard V2 commands; it does not need stream-specific code.
- The proxy/executor settles periods with V2 vocabulary such as
  `Allocation_Settle` and `SettlementFactory_SettleBatch`.

## Quick Start

### Prerequisites

- Node.js 22.14 or newer
- pnpm 9.15 via Corepack
- Docker, for the local app stack
- A CIP-103 wallet gateway for real wallet-backed flows

Enable pnpm:

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

Install dependencies:

```bash
pnpm install
```

### Run the local app stack

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts:

| Service                 | URL / port              |
| ----------------------- | ----------------------- |
| Dashboard               | `http://localhost:3000` |
| REST proxy              | `http://localhost:4000` |
| Canton participant gRPC | `localhost:5001`        |
| Canton admin API        | `localhost:5002`        |

This does not start the Splice Amulet wallet. For wallet-backed E2E, run a
Splice LocalNet validator wallet from `canton-network/splice` on the
`token-standard-v2-upcoming` branch and expose the dapp gateway at:

```text
http://localhost:3030/api/v0/dapp
```

### Skip the wallet picker in local automation

Create `packages/dashboard/.env.local`:

```bash
VITE_SKIP_WALLET_PICKER=true
VITE_WALLET_GATEWAY_URL=http://127.0.0.1:3030/api/v0/dapp
VITE_WALLET_NAME=Splice Amulet Wallet (LocalNet V2)
```

With this mode enabled, the dashboard connects directly to the configured
remote Amulet wallet. If the wallet gateway is not running, the UI shows an
explicit error instead of opening an unreachable popup.

### Run without Docker

```bash
pnpm --filter @canton-streams/proxy dev
pnpm --filter @canton-streams/dashboard dev --host 127.0.0.1
```

See [docs/QUICKSTART.md](docs/QUICKSTART.md) for the longer local setup,
example payloads, and wallet notes.

## Use The SDK

The SDK is intended for host applications that want to create or operate streams
without copying dashboard code.

New stream creation requires V2 fields:

```ts
import Decimal from 'decimal.js';
import { AssetType, SettlementMode, VestingMode } from '@canton-streams/sdk';

const params = {
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

The SDK rejects old settlement modes for new streams. If you still see legacy
names in the type system, they exist so older contracts can be read and migrated.

## Repository Map

| Path                  | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `packages/daml/`      | Daml templates and tests                                      |
| `packages/sdk/`       | TypeScript SDK, transports, validators, V2 allocation helpers |
| `packages/proxy/`     | Express REST proxy and settlement/event workers               |
| `packages/dashboard/` | React reference UI with CIP-103 wallet connection             |
| `packages/cli/`       | Operator CLI                                                  |
| `packages/executor/`  | Bounded automation runner for delegated policies              |
| `docker/`             | Local app stack                                               |
| `docs/`               | Guides, architecture, deployment, runbooks, threat model      |

## Read Next

| If you want to...      | Read                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| Run the app locally    | [docs/QUICKSTART.md](docs/QUICKSTART.md)                             |
| Understand the design  | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                         |
| Integrate as a dapp    | [docs/integration-guide/README.md](docs/integration-guide/README.md) |
| Deploy safely          | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)                             |
| Review risks           | [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)                         |
| Configure wallet flows | [docs/SWK-WALLET-RUNBOOK.md](docs/SWK-WALLET-RUNBOOK.md)             |
| Check REST endpoints   | [docs/API.md](docs/API.md)                                           |

## Development

Run the main checks:

```bash
pnpm --filter @canton-streams/sdk test
pnpm --filter @canton-streams/dashboard test
pnpm --filter @canton-streams/sdk build
pnpm --filter @canton-streams/proxy build
pnpm --filter @canton-streams/dashboard build
pnpm --filter @canton-streams/cli build
```

Validate Docker wiring:

```bash
docker compose -f docker/docker-compose.yml config
```

Daml commands:

```bash
pnpm daml:deps
pnpm daml:build
pnpm daml:test
```

## Contributing

Contributions are welcome. Start with:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

For a first PR, prefer small changes with a clear test. Good starter areas are
documentation clarity, SDK validation tests, dashboard copy, and local runbook
improvements.

## License

[Apache 2.0](LICENSE)
