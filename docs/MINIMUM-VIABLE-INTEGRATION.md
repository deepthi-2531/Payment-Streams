# Minimum Viable Integration

The shortest path from a clean checkout to a working Canton Payment Stream — one stream variant, one V2 asset, one wallet flow, one executor.

If you complete the steps below you have a working integration. Skip nothing.

## What you'll end up with

- One `StreamAdmin` stream (linear vesting)
- One CIP-56 V2 asset (your choice — CC, USDCx, or a V2-native test instrument)
- One CIP-103 wallet connection (the Splice Amulet wallet, or any compliant gateway)
- One executor running `Allocation_Settle` per accrual interval

Anything beyond that — `StreamFlow`, `MilestoneAdmin`, batch create, `DelegatedPolicy`, featured-app marker emission — is documented in [INTEGRATION-EXAMPLE.md](INTEGRATION-EXAMPLE.md) and treated as optional.

## Prerequisites

- Node 22.14+ and pnpm 9.15+ via Corepack
- Docker for the local Canton stack
- A running CIP-103 wallet gateway exposing `:3030/api/v0/dapp` — Splice LocalNet's Amulet wallet is the reference

You do not need the upstream Splice repo cloned for this path. You do not need to build any DARs from source. The bundled Docker stack carries the canton-streams DAR.

## The five steps

### 1. Start the local stack

```bash
git clone git@github.com:deepthi-2531/Payment-Streams.git
cd Payment-Streams
pnpm install
docker compose -f docker/docker-compose.yml up -d
```

Verify:

```bash
curl http://localhost:4000/api/health      # proxy → "status":"ok"
curl http://localhost:7575/v2/version       # canton json-api → "version":"3.4..."
open http://localhost:3000                  # dashboard landing
```

### 2. Register your asset

Edit `config/asset-registry.json` and add one entry — admin party, scan endpoint, wallet-gateway URL, capability flags. The SDK reads this at runtime; do not hardcode an asset name anywhere in your code.

```jsonc
{
  "assets": [
    {
      "id": "MyAsset",
      "admin": "MyAssetAdmin::1220...",
      "scanEndpoint": "https://scan.example",
      "walletGatewayUrl": "http://localhost:3030/api/v0/dapp",
      "capabilities": {
        "transfersV2": true,
        "allocationsV2": true,
        "transferEventsV2": true
      }
    }
  ]
}
```

### 3. Connect the wallet

Open `http://localhost:3000`. Click **Connect wallet**. Pick the configured Amulet remote wallet. Approve in the wallet UI.

If the wallet gateway isn't running, the dashboard fails closed with a clear message — there is no popup-fallback path.

For automation, set `VITE_SKIP_WALLET_PICKER=true` in `packages/dashboard/.env.local` to bypass the picker UI.

### 4. Create one stream

In the dashboard:

1. Click **Create stream**
2. Pick **`StreamAdmin`** (the prefunded, bounded-term variant)
3. Fill in recipient, asset (the one from step 2), total amount, start time, end time, vesting mode `Linear`
4. Click **Create** — your wallet asks you to sign the V2 `AllocationRequest`
5. Switch to the recipient (a second wallet or a second party in the same wallet) and click **Accept** in their **Inbox** — atomic funding lock fires via `AllocationFactory_Allocate(committed=True)`

Equivalent SDK call, if you prefer:

```ts
import { buildAllocationRequest, VestingMode, SettlementMode } from '@canton-streams/sdk';
import { dappSDK } from '@canton-network/dapp-sdk';

const request = buildAllocationRequest(caps, {
  settlement: { executor: 'EscrowOperator::...', settlementRefId: 'stream-1', requestedAt: new Date() },
  legs: [{ legId: 'leg-1', leg: { sender, receiver, amount: new Decimal('100'),
                                  instrumentId: { admin, id: 'MyAsset' } } }],
  committed: true,
}, templateId);

await dappSDK.prepareExecuteAndWait({ commands: request.commands, actAs: [sender] });
```

### 5. Watch the executor settle

The proxy's `TransferEventsV2` subscriber drives `Allocation_Settle` automatically on each accrual interval. You don't write that worker.

```bash
curl http://localhost:4000/api/streams \
  -H "Authorization: Bearer $JWT"
```

The recipient's holding balance increases at the configured cadence; `Allocation.settled` is monotonic; stream state advances on every settle.

When `endTime` is reached, the final settle drains the lock and archives the `Allocation` — stream marks `Completed`.

## What to read after this works

| If you need… | Read |
|---|---|
| The full integration template | [INTEGRATION-EXAMPLE.md](INTEGRATION-EXAMPLE.md) |
| Production deployment / env vars / DAR vetting | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Annotated traces for `StreamFlow`, `MilestoneAdmin`, batch, cancel | [WALKTHROUGHS.md](WALKTHROUGHS.md) |
| REST API | [API.md](API.md) |
| Trust boundaries + invariants | [THREAT-MODEL.md](THREAT-MODEL.md) |
| Wiring against a live remote validator | [TESTNET-RUNBOOK.md](TESTNET-RUNBOOK.md) |

## Common dead ends

- **DAR uploaded but not vetted.** Symptom: create succeeds but settle fails with `UNKNOWN_PACKAGE`. Fix: vet the canton-streams package id on the synchronizer. The proxy's `PROXY_STARTUP_REQUIRE_VETTED_PACKAGES=1` flag catches this at startup.
- **Wallet gateway URL wrong in the registry.** Symptom: dashboard shows "wallet gateway not reachable". Fix: check that `walletGatewayUrl` points to a CIP-103 endpoint, not a UI.
- **Proxy talking to the wrong participant.** Symptom: stream visible on one side, missing on the other. Fix: cross-check `CANTON_HOST`, `CANTON_PORT`, and `CANTON_SYNCHRONIZER_ID` env vars match where the recipient's party lives.
- **JWT party claim missing.** Symptom: proxy returns `missing_party`. Fix: the proxy reads identity from the JWT `party` (or `sub`) claim; legacy `X-Canton-Party` header is accepted but not required.
