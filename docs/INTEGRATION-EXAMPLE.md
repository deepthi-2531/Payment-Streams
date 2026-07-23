# Integration Example

End-to-end host-app integration of Canton Payment Streams through the CIP-103
wallet flow and the CIP-56 token standard. V2 is the preferred allocation lane;
registered V1 assets can use the transitional V1 lane until they advertise V2.
This walks through a complete vesting-stream rollout for a hypothetical host app.

Canton Payment Streams ships **two funding models**:

- **Prefunded** (`StreamAdmin` / `StreamEscrow`) — bounded term, the total is committed up front. This example uses the prefunded path.
- **Non-prefunded** (`StreamFlow`) — open-ended, the sender keeps a funded balance via rolling top-ups and withdrawals are bounded by that balance. See the [Subscriptions variation](#subscriptions-instead-of-fixed-term) below, and the dedicated reference [`integration-guide/non-prefunded-flow.md`](integration-guide/non-prefunded-flow.md).

## Scenario

`AcmeCo` runs a Canton-based marketplace. They want to ship a "streaming payroll" feature where employees get paid continuously across the month instead of a lump sum on the 1st.

- Sender: `AcmeCo` treasury party
- Recipient: each employee party
- Asset: `USDCx` (or any registered CIP-56 asset; V2 preferred, V1 transitional)
- Schedule: `Linear` vesting from the 1st of the month to the 1st of the next month

## Step 1 — Register the asset

Add an entry to `config/asset-registry.json`:

```json
{
  "assets": {
    "usdcx": {
      "key": "usdcx",
      "displayName": "USDCx",
      "instrumentIdV2": {
        "admin": "USDCxAdmin::1220...",
        "id": "USDCx"
      },
      "adminParty": "USDCxAdmin::1220...",
      "scanEndpointUrl": "https://scan.example.com",
      "walletGatewayUrl": "https://wallet.example.com/api/v0/dapp",
      "tokenStandardApiUrl": "https://token-standard.example.com",
      "allocationsV2": true,
      "allocationsV1": false,
      "transferEventsV2": true
    }
  }
}
```

The SDK reads this on startup. When AcmeCo's frontend builds a stream
against a registered asset (e.g. `registry.requireAsset('usdcx')`), the
library uses the V2 adapter when available and the transitional V1 adapter
only when the asset entry explicitly advertises `allocationsV1`.

## Step 2 — Provision identities

```bash
node scripts/provision-streams-service.mjs \
  --api-url http://acme-validator:7575 \
  --admin-token "$ACME_PARTICIPANT_ADMIN_TOKEN" \
  --user-id streams-service \
  --primary-party "AcmeStreamsEscrow::1220..." \
  --grant-read-as-any-party \
  --act-as "AcmeStreamsEscrow::1220..."
```

This gives the proxy a least-privilege service principal: it can read any party's contracts (for stream visibility) and act as the escrow operator only.

## Step 3 — Deploy and vet the canton-streams DAR

```bash
# Upload
daml ledger upload-dar --host acme-validator --port 5001 \
  packages/daml/main/.daml/dist/canton-streams-1.3.0.dar

# Vet on the synchronizer (see docs/DEPLOYMENT.md for the console snippet)

# Capture the new package id
export CANTON_STREAMS_PACKAGE_ID=<new-package-hash>
```

Verify with `curl http://acme-validator:7575/v2/packages` — the new id appears.

## Step 4 — Configure the proxy

`.env` for AcmeCo's proxy deployment:

```env
PROXY_PORT=4000
PROXY_AUTH_MODE=jwt
PROXY_OIDC_ISSUER=https://acme-auth.example.com
PROXY_JWT_AUDIENCE=https://acme.example.com/canton
PROXY_SERVICE_TOKEN=<service-jwt>
PROXY_ESCROW_OPERATOR=AcmeStreamsEscrow::1220...

CANTON_HOST=acme-validator
CANTON_PORT=5001
CANTON_USE_TLS=true
CANTON_JSON_API_URL=https://acme-validator:7575
CANTON_SYNCHRONIZER_ID=global-domain::1220...
CANTON_STREAMS_PACKAGE_ID=<package-hash>

PROXY_STARTUP_REQUIRE_VETTED_PACKAGES=1
PROXY_STARTUP_REQUIRE_INTERACTIVE_SUBMISSION_ENDPOINT=1

PROXY_TOKEN_STANDARD_AUTOWITHDRAW_ENABLED=true
PROXY_AUTO_WITHDRAW_SUBSCRIBER_MODE=true
PROXY_SERVICE_USER_ID=streams-service

ALLOWED_ORIGINS=https://app.acme.example.com
```

Start the proxy:

```bash
node packages/proxy/dist/index.js
```

`GET /api/health` returns `"status": "ok"` with all readiness checks green.

## Step 5 — Wire AcmeCo's frontend

AcmeCo already has a payroll dashboard. They add a "Streaming pay" tab.

### Connect wallet

```typescript
import { dappSDK } from '@canton-network/dapp-sdk';

await dappSDK.init();
const status = await dappSDK.status();
if (!status.connection.isConnected) {
  await dappSDK.connect();
}
const accounts = await dappSDK.listAccounts();
const treasuryParty = accounts.find((a) => a.primary)!.partyId;
```

The user picks their wallet (Splice Wallet Kernel, browser extension, etc.) and signs in via the wallet's IDP. AcmeCo's frontend gets back an authenticated session.

### Create a stream

```typescript
import { CantonStreamsClient, VestingMode, SettlementMode } from '@canton-streams/sdk';
import Decimal from 'decimal.js';

// `client` is a CantonStreamsClient configured with the treasury's
// wallet-issued credentials (Path A) or a service-party signer (Path B).
async function createSalaryStream(employeeParty: string, monthlySalary: Decimal) {
  const startTime = startOfMonth(new Date());
  const endTime = startOfMonth(addMonths(new Date(), 1));

  const { streamId } = await client.createStream({
    streamId: `salary-${employeeParty}-${startTime.getFullYear()}-${startTime.getMonth() + 1}`,
    sender: treasuryParty,
    recipient: employeeParty,
    totalDeposited: monthlySalary,
    startTime,
    endTime,
    vestingMode: { mode: VestingMode.Linear },
    settlementMode: SettlementMode.TokenStandardCustody,
    instrumentRef: usdcxRef,            // from registry.requireAsset('USDCx')
    fundingReference: walletFundingRef, // from the wallet's V2 allocation step
    escrowOperator: 'AcmeStreamsEscrow::1220...',
    cancellable: false,
  });

  return streamId;
}
```

The treasury party signs through their wallet. The create emits the
underlying CIP-0112 `AllocationRequest`, which lands on-ledger and is
visible to the employee party.

### Bulk-create for the whole company

To create many streams from one operator workflow, pass an array of the same
per-stream params to `client.createBatch({ streams: [...] })` — one signature,
N streams. See the batch-create walkthrough in
[`WALKTHROUGHS.md`](WALKTHROUGHS.md).

### Employee accepts

In the employee's dashboard:

```typescript
// The employee's client recipient accepts each pending request with
// client.acceptStream(sender, streamId) (see packages/sdk/src/client.ts).
const incoming = await client.listPendingStreamRequests();

for (const req of incoming) {
  await client.acceptStream(req.config.sender, req.config.streamId);
}
```

On accept, the funding `AllocationFactory_Allocate(committed=True)` settles atomically — treasury's USDCx locks against the escrow.

## Step 6 — Watch the stream advance

When enabled, the proxy's auto-withdraw subscriber advances settlement as funds accrue (opt-in worker; poll cadence defaults to 10 seconds, configurable via `PROXY_TOKEN_STANDARD_AUTOWITHDRAW_POLL_INTERVAL_MS`). This worker is off unless `PROXY_TOKEN_STANDARD_AUTOWITHDRAW_ENABLED=true`, and is not active in the current live deployment.

Employees see their balance tick up in real time in AcmeCo's dashboard. They can withdraw to their main wallet at any time:

```typescript
await fetch(`/api/streams/${treasuryParty}/${streamId}/withdraw`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${await dappSDK.getAccessToken()}` },
});
```

If the auto-withdraw worker is enabled, on-chain settlement advances on each poll interval and the recipient's wallet holding balance updates automatically. That worker is opt-in and disabled in the current live deployment, so the manual `POST .../withdraw` above remains the reliable path.

## Step 7 — Adoption metrics + reporting

AcmeCo wants monthly reports on streaming payroll activity:

```bash
node scripts/query-adoption-metrics.mjs \
  --asset-registry config/asset-registry.json \
  --since 2026-05-01 \
  --until 2026-06-01 \
  --exclude-parties "$ACME_INTERNAL_TEST_PARTIES" \
  --output report-2026-05.json
```

Output includes distinct streams, cumulative notional, days continuous, and per-asset breakdowns. AcmeCo feeds this into their finance dashboard.

## Common variations

The prefunded vesting arc above is one shape. The other common shapes have
dedicated references — mirror those rather than re-deriving them here:

- **Subscriptions / usage-shaped billing** — use the non-prefunded `StreamFlow`
  path (`client.createFlow` + rolling `client.topUpFlow`); withdrawals are
  bounded by the funded balance (no unsecured credit). `StreamFlow` is
  currently an operator/co-hosted reference; a hosted-wallet StreamFlow UX is
  future work. Full lifecycle:
  [`integration-guide/non-prefunded-flow.md`](integration-guide/non-prefunded-flow.md).
- **Milestone-gated releases** — admin-driven: the operator creates a
  `MilestoneAdmin` contract recording the milestone list, and the sender
  approves a single multi-leg `AllocationFactory_Allocate` (one
  `TransferLegSide` per milestone, `committed=True`). Each leg settles with
  `Allocation_Settle` when the operator confirms the milestone (via
  `Confirm_Milestone`); reconcile against the authoritative allocation, not the
  admin record. See [`WALKTHROUGHS.md`](WALKTHROUGHS.md).
- **Trust-minimized executor** — the recipient creates an on-ledger
  `DelegatedPolicy` (`CantonStreams.Policy.DelegatedPolicy`) bounding the
  executor's authority (allowed actions, rate limit, max per execution, expiry)
  and can revoke at any time; the proxy's executor honors those on-ledger
  bounds. SDK read/revoke: `client.listPolicies`, `client.listExecutionLogs`,
  `client.revokePolicy` (`packages/sdk/src/commands/policy.ts`).

## Validation checklist before going to production

- [ ] DAR uploaded **and** vetted on the synchronizer
- [ ] `GET /api/health` returns `"status": "ok"` with all readiness checks green
- [ ] Service principal has only `CanReadAsAnyParty` + `CanActAs` for the escrow operator (not admin)
- [ ] Wallet-gateway URL configured and tested with a real wallet
- [ ] One end-to-end stream completes: create → accept → settle → recipient holding balance increases
- [ ] `TransferEventsV2` subscriber is consuming events without lag
- [ ] Adoption-metrics script runs against the production Scan endpoint(s)
- [ ] Logs forwarded to your aggregator
- [ ] Security review of the JWT issuer, allowed origins, and CORS configuration

## Where to go from here

- [DEPLOYMENT.md](DEPLOYMENT.md) — full environment-variable matrix
- [DEPLOYMENT.md](DEPLOYMENT.md) — environment variables, health checks, and production hardening
- [API.md](API.md) — REST endpoint reference
- [integration-guide/](integration-guide/) — per-asset config and CIP-103 walkthrough
