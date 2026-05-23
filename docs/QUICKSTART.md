# Quick Start

Get Canton Payment Streams running locally in ~5 minutes.

## Prerequisites

- **Node.js** >= 22.14
- **pnpm** >= 9.15 (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- **Docker** + **Docker Compose**
- **Daml SDK** 3.4.10 (for Daml builds — only needed if you change `.daml` sources)

## Option A — Docker (fastest)

```bash
docker compose -f docker/docker-compose.yml up -d
```

Brings up:

| Service | URL | Purpose |
|---|---|---|
| Dashboard | http://localhost:3000 | React UI |
| REST proxy | http://localhost:4000 | Streams REST API |
| Canton gRPC ledger API | localhost:5001 | SDK + proxy gRPC connection |
| Canton JSON API | http://localhost:7575 | Browser / JSON-API queries |
| Canton Admin API | localhost:5002 | DAR upload, party allocation |

Watch readiness:

```bash
docker compose -f docker/docker-compose.yml logs -f canton
# wait for "Canton node started successfully"
```

Reset state:

```bash
docker compose -f docker/docker-compose.yml down -v
```

## Option B — Local development

```bash
# 1. Install + build
pnpm install
pnpm build                # builds all TypeScript packages

# 2. Build Daml DARs (only when changing Daml sources)
pnpm daml:deps            # fetches Splice V2 dependency DARs into .lib/
pnpm daml:build           # builds packages/daml/main/.daml/dist/canton-streams-0.2.8.dar

# 3. Start the Canton sandbox (separately — see docs/DEPLOYMENT.md for options)

# 4. Start proxy + dashboard in watch mode
pnpm dev
```

## Connect a wallet

The dashboard uses [CIP-103](https://github.com/canton-foundation/cips/blob/main/cip-0103/cip-0103.md) for end-user wallet authentication via `@canton-network/dapp-sdk`.

1. Open http://localhost:3000
2. Click **Connect wallet** on the landing page
3. The dapp-sdk wallet picker opens — select your CIP-103 wallet (e.g. [Splice Wallet Kernel](https://github.com/canton-network/splice-wallet-kernel) running locally at `:3030`)
4. Complete the IDP sign-in in the wallet popup
5. Dashboard transitions to the authenticated layout

For a local SWK setup, see [SWK-WALLET-RUNBOOK.md](SWK-WALLET-RUNBOOK.md).

**Skip the wallet picker for local dev:** set `VITE_SKIP_WALLET_PICKER=true` in `packages/dashboard/.env.local` to auto-select the configured remote wallet. Template: `packages/dashboard/.env.example`.

**Dev fallback without a wallet:** the landing page has a "Use dev-mode credentials" toggle. Paste a JWT and party id to bypass the wallet flow. Only works against a proxy running in `PROXY_AUTH_MODE=dev`.

## Create your first stream

### From the dashboard

1. Click **Create stream** in the top-right
2. Pick a stream variant:
   - **Streaming payment** (`StreamAdmin` — prefunded, bounded-term) — for vesting, LP rewards
   - **Subscription** (`StreamFlow` — iterated, variable funding) — for recurring billing
   - **Milestone** (`MilestoneAdmin` — event-triggered tranches) — for grant unlocks
3. Fill in:
   - **Recipient**: recipient party id
   - **Asset**: pick from your registered assets (defined in `config/asset-registry.json`)
   - **Amount**: e.g. `100.0`
   - **Vesting**: Linear / Cliff / Stepped / RenewableTerm
   - **Start / End**: now → +1h, or any window
4. Click **Create** → the wallet picker pops up for sender signature → stream lands on-ledger as an `AllocationRequest`

The recipient sees the request in their **Inbox** tab. They click **Accept** → their wallet signs → the funding `AllocationFactory_Allocate(committed=True)` settles atomically.

### From the REST API (server-side)

The proxy supports server-side automation via a service JWT. The proxy reads identity from the JWT `party`/`sub` claim; no separate party header is required.

```bash
PROXY=http://localhost:4000
TOKEN="<your-service-jwt>"     # JWT with 'party' claim

# Create a stream
curl -X POST $PROXY/api/streams \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "streamId": "first-stream",
    "recipient": "Bob::1220...",
    "totalDeposited": "100.0",
    "vestingMode": { "mode": "Linear" },
    "startTime": "'"$(date -u +%FT%TZ)"'",
    "endTime": "'"$(date -u -v+1H +%FT%TZ)"'",
    "settlementMode": "TokenStandardCustody",
    "asset": { "instrumentId": "MyAsset", "admin": "MyAssetAdmin::1220..." },
    "cancellable": true
  }'

# List streams
curl $PROXY/api/streams -H "Authorization: Bearer $TOKEN"

# Withdraw accrued funds (as recipient)
curl -X POST "$PROXY/api/streams/SenderParty::1220.../first-stream/withdraw" \
  -H "Authorization: Bearer $TOKEN"
```

### From the SDK (browser, CIP-103 wallet)

```typescript
import { dappSDK } from '@canton-network/dapp-sdk';
import {
  buildAllocationRequest,
  VestingMode,
  SettlementMode,
} from '@canton-streams/sdk';
import Decimal from 'decimal.js';

await dappSDK.init();
await dappSDK.connect();
const accounts = await dappSDK.listAccounts();
const sender = accounts.find((a) => a.primary)!.partyId;

const request = buildAllocationRequest({
  sender,
  recipient: 'Bob::1220...',
  asset: { instrumentId: 'MyAsset', admin: 'MyAssetAdmin::1220...' },
  totalAmount: new Decimal('100'),
  vestingMode: { mode: VestingMode.Linear },
  startTime: new Date(),
  endTime: new Date(Date.now() + 3_600_000),
  settlementMode: SettlementMode.TokenStandardCustody,
});

const { txId } = await dappSDK.prepareExecuteAndWait({
  commands: request.commands,
  actAs: [sender],
});

console.log(`Stream created: ${txId}`);
```

### From the SDK (server-side, JWT)

```typescript
import { CantonStreamsClient, VestingMode, SettlementMode } from '@canton-streams/sdk';
import Decimal from 'decimal.js';

const client = new CantonStreamsClient({
  host: 'localhost',
  port: 5001,
  actAs: ['Alice::1220...'],
  token: process.env.PROXY_SERVICE_TOKEN!,
});

const { streamId } = await client.createStream({
  streamId: 'first-stream',
  sender: 'Alice::1220...',
  recipient: 'Bob::1220...',
  totalDeposited: new Decimal('100'),
  vestingMode: { mode: VestingMode.Linear },
  startTime: new Date(),
  endTime: new Date(Date.now() + 3_600_000),
  cancellable: true,
  settlementMode: SettlementMode.TokenStandardCustody,
  asset: { instrumentId: 'MyAsset', admin: 'MyAssetAdmin::1220...' },
});

await client.close();
```

## Next steps

- [Architecture](ARCHITECTURE.md) — system design + V2 capability negotiation
- [REST API Reference](API.md) — full endpoint documentation
- [Deployment Guide](DEPLOYMENT.md) — environment variables, DAR upload + vetting, production hardening
- [Integration Example](INTEGRATION-EXAMPLE.md) — end-to-end host-app integration walkthrough
- [Testnet Runbook](TESTNET-RUNBOOK.md) — point your local proxy + dashboard at a remote validator
