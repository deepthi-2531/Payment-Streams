# Wallet-Backed V2 E2E Harness

This runbook proves a clean checkout can drive the Streams dashboard against
a real CIP-103 wallet gateway and a Canton LocalNet. It is the path to use
when unit tests are not enough and you want to verify the sender, receiver,
wallet, and executor surfaces together.

The harness uses CIP-56 V2 vocabulary only:

- `AllocationFactory_Allocate`
- `Allocation_Settle`
- `SettlementFactory_SettleBatch`

V1 command names are rejected by `scripts/check-v2-conformance.sh`.

## Requirements

| Component | Version |
| --- | --- |
| Operating system | macOS or Linux |
| Docker | 24 or newer with `docker compose` |
| Git | 2.40 or newer |
| Node.js | 22.14 or newer |
| pnpm | 9.15 via Corepack |
| Daml SDK | 3.4.x |
| Java, sbt, Postgres | Required by the Splice LocalNet validator |
| Disk space | 20 GB free for the Splice clone and build artifacts |
| RAM | 8 GB free minimum, 16 GB recommended |

The first LocalNet build can take 10 to 30 minutes on a cold cache.

## Upstream Pin

The harness uses the Splice commit recorded in `scripts/fetch-v2-dars.mjs`:

- `SPLICE_PINNED_COMMIT`
- `SPLICE_PINNED_AS_OF`

Override with `SPLICE_PINNED_COMMIT=<sha>` when validating an upstream patch
before bumping the repository pin.

## Step 1: Start Splice LocalNet

Prepare the upstream LocalNet checkout:

```bash
bash scripts/start-localnet-e2e.sh
```

Then start LocalNet from the printed `.splice-localnet/` directory:

```bash
cd .splice-localnet
docker --version && docker compose version
./build-tools/splice-localnet-compose.sh start
```

The upstream compose stack starts Canton, validators, wallet UIs, and JSON
Ledger API ports. Common LocalNet endpoints are:

| Endpoint | Purpose |
| --- | --- |
| `http://localhost:2975` | app-user participant JSON Ledger API |
| `http://localhost:3975` | app-provider participant JSON Ledger API |
| `http://localhost:2000` | app-user wallet UI |
| `http://localhost:3000` | app-provider wallet UI |
| `http://localhost:4000` | super-validator wallet UI |

## Step 2: Start A CIP-103 Wallet Gateway

LocalNet wallet UIs are not the same thing as the CIP-103 dApp gateway used
by the dashboard. Start a wallet gateway and point it at the LocalNet
participant you want to test with:

```bash
npx @canton-network/wallet-gateway-remote@latest --config-example > wallet-gateway.localnet.json
```

Edit the generated config:

```jsonc
{
  "ledgerApi": {
    "baseUrl": "http://127.0.0.1:2975"
  },
  "allowedOrigins": [
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]
}
```

Then run:

```bash
npx @canton-network/wallet-gateway-remote@latest -c wallet-gateway.localnet.json -p 3030
```

Probe it:

```bash
curl -fsS -X POST http://localhost:3030/api/v0/dapp \
  -H 'Origin: http://localhost:3000' \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"probe","method":"status","params":{}}'
```

If your gateway uses a different URL, export it before starting Streams:

```bash
export VITE_WALLET_GATEWAY_URL=http://localhost:3030/api/v0/dapp
```

## Step 3: Start The Streams Stack

With LocalNet and the wallet gateway already running, start only the Streams
services:

```bash
SKIP_LOCALNET_BUILD=1 bash scripts/start-localnet-e2e.sh
```

The dashboard receives these defaults:

```text
VITE_WALLET_LAYER=dapp-sdk
VITE_WALLET_GATEWAY_URL=http://localhost:3030/api/v0/dapp
VITE_SKIP_WALLET_PICKER=true
VITE_WALLET_NAME=Splice Amulet Wallet
```

If the dashboard port collides with an upstream wallet UI, set
`STREAMS_DASHBOARD_PORT` before starting the stack and add that origin to the
wallet gateway allowlist.

## Step 4: Run The Sender And Receiver Flow

Open the dashboard at `http://localhost:3000`.

1. Connect the sender wallet.
2. Create a stream to the receiver party using a V2-capable asset.
3. Confirm the sender can see the stream in the Streams view.
4. Connect as the receiver in a second browser profile or incognito window.
5. Confirm the receiver can see the stream in Inbox.
6. Complete any required allocation approval in the wallet UI.
7. Confirm the executor advances settlement and logs V2 settlement events.

The dashboard should never pretend it accepted on the receiver's behalf. If
wallet approval is required, the user completes it in the wallet and returns
to Streams.

## Step 5: Verify Fail-Closed Wallet Behavior

Stop the wallet gateway and click Connect wallet again.

Expected behavior:

- The dashboard shows an inline message that the wallet gateway is not
  reachable.
- No popup window opens.
- The network log shows a single JSON-RPC `status` probe to the configured
  gateway URL.

This protects hosted and headless flows from silently falling back to a fake
wallet path.

## Hosted Wallet E2E With PartyLayer

Use PartyLayer when you want hosted multi-wallet UX instead of a direct
LocalNet gateway:

```bash
VITE_WALLET_LAYER=partylayer \
VITE_PARTYLAYER_NETWORK=devnet \
VITE_PARTYLAYER_APP_NAME='Canton Payment Streams' \
docker compose -f docker/docker-compose.yml up -d --build --no-deps dashboard
```

Test the same user-visible flow:

1. Connect through the PartyLayer picker.
2. Select a wallet such as 5N Loop or Console.
3. Create a stream as the sender.
4. Open a separate receiver session.
5. Confirm the receiver sees the incoming stream.
6. Complete wallet approval in the selected wallet UI.
7. Return to Streams and confirm the stream state and executor logs.

PartyLayer mode currently treats approval completion as manual because the
hosted provider layer does not expose automatic prepare-and-wait completion
to the dashboard. That is intentional and safer than claiming an unsupported
automatic approval path.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `docker` is missing | Docker is not installed or not running | Start Docker Desktop or `dockerd`, then run `docker info`. |
| LocalNet takes a long time | First Splice clone/build on a cold cache | Let the build finish; later runs reuse the checkout. |
| Wallet probe times out | Gateway is not running or points at the wrong participant | Recheck the gateway config and LocalNet participant port. |
| Dashboard cannot connect | `VITE_WALLET_GATEWAY_URL` or allowed origins are wrong | Confirm `docker compose config` and the gateway allowlist. |
| Stream create succeeds but wallet does not prompt | The selected wallet or asset cannot perform the V2 approval | Use a wallet and asset known to support the V2 allocation flow. |
| Conformance check fails | A file references a forbidden V1 command name | Replace the command with the V2 shape or add a documented allowlist exception. |

## Related Files

- `scripts/start-localnet-e2e.sh`
- `scripts/fetch-v2-dars.mjs`
- `scripts/check-v2-conformance.sh`
- `docker/docker-compose.yml`
- `docs/HOSTED-WALLET-PLAN.md`
- `docs/QUICKSTART.md`
