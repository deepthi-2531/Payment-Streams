# Integration Example

End-to-end host-app integration of Canton Payment Streams, V2-only via the CIP-103 wallet flow and CIP-56 V2 token standard. This walks through a complete vesting-stream rollout for a hypothetical host app.

## Scenario

`AcmeCo` runs a Canton-based marketplace. They want to ship a "streaming payroll" feature where employees get paid continuously across the month instead of a lump sum on the 1st.

- Sender: `AcmeCo` treasury party
- Recipient: each employee party
- Asset: `USDCx` (or any other CIP-56 V2 asset)
- Schedule: `Linear` vesting from the 1st of the month to the 1st of the next month

## Step 1 — Register the asset

Add an entry to `config/asset-registry.json`:

```json
{
  "assets": [
    {
      "id": "USDCx",
      "admin": "USDCxAdmin::1220...",
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

The SDK reads this on startup. When AcmeCo's frontend calls `buildAllocationRequest({ asset: { instrumentId: 'USDCx', admin: 'USDCxAdmin::...' } })`, the library uses the V2 adapter automatically.

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
  packages/daml/main/.daml/dist/canton-streams-0.2.8.dar

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

PROXY_TRANSFER_EVENTS_ENABLED=1
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
import { buildAllocationRequest, VestingMode, SettlementMode } from '@canton-streams/sdk';
import Decimal from 'decimal.js';

async function createSalaryStream(employeeParty: string, monthlySalary: Decimal) {
  const startTime = startOfMonth(new Date());
  const endTime = startOfMonth(addMonths(new Date(), 1));

  const request = buildAllocationRequest({
    sender: treasuryParty,
    recipient: employeeParty,
    asset: { instrumentId: 'USDCx', admin: 'USDCxAdmin::1220...' },
    totalAmount: monthlySalary,
    vestingMode: { mode: VestingMode.Linear },
    startTime,
    endTime,
    settlementMode: SettlementMode.TokenStandardCustody,
    cancellable: false,
  });

  const { txId } = await dappSDK.prepareExecuteAndWait({
    commands: request.commands,
    actAs: [treasuryParty],
  });

  return txId;
}
```

The treasury party signs through their wallet. The `AllocationRequest` lands on-ledger and is visible to the employee party.

### Bulk-create for the whole company

```typescript
import { batchCreate } from '@canton-streams/sdk';

const employees = await acmeHR.getEmployeesWithSalaries();

const batchRequest = batchCreate(
  employees.map((emp) => ({
    sender: treasuryParty,
    recipient: emp.party,
    asset: { instrumentId: 'USDCx', admin: 'USDCxAdmin::1220...' },
    totalAmount: emp.monthlySalary,
    vestingMode: { mode: VestingMode.Linear },
    startTime,
    endTime,
    settlementMode: SettlementMode.TokenStandardCustody,
  })),
);

const { txId } = await dappSDK.prepareExecuteAndWait({
  commands: batchRequest.commands,
  actAs: [treasuryParty],
});
```

One signature, N streams.

### Employee accepts

In the employee's dashboard:

```typescript
const incoming = await fetch('/api/pending?direction=incoming').then(r => r.json());

for (const req of incoming) {
  const acceptRequest = buildAcceptAllocationRequest({ requestContractId: req.contractId });
  await dappSDK.prepareExecuteAndWait({
    commands: acceptRequest.commands,
    actAs: [req.recipient],
  });
}
```

On accept, the funding `AllocationFactory_Allocate(committed=True)` settles atomically — treasury's USDCx locks against the escrow.

## Step 6 — Watch the stream advance

The proxy's `TransferEventsV2` subscriber exercises `Allocation_Settle` automatically as funds accrue (configurable cadence; default: per accrual minute).

Employees see their balance tick up in real time in AcmeCo's dashboard. They can withdraw to their main wallet at any time:

```typescript
await fetch(`/api/streams/${treasuryParty}/${streamId}/withdraw`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${await dappSDK.getAccessToken()}` },
});
```

Or skip the manual withdraw entirely — the proxy already settles on-chain on each accrual interval; the recipient's wallet holding balance updates automatically.

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

### Subscriptions instead of fixed-term

For SaaS-style monthly billing where the bill amount changes month-to-month, use `StreamFlow` instead of `StreamAdmin`:

```typescript
const request = buildAllocationRequest({
  // ...
  streamType: 'flow',          // → StreamFlow + StreamFlowAdmin templates
  fundingPerPeriod: monthlyBill,
  periodDuration: { days: 30 },
});
```

The sender keeps the funded balance topped up via `TopUp` between iterations; withdrawals are bounded by the actually-funded balance (no unsecured credit).

### Milestone-gated releases

For an `AcmeSponsor` milestone program disbursed as KPIs hit:

```typescript
const request = buildAllocationRequest({
  // ...
  streamType: 'milestone',     // → MilestoneAdmin template
  milestones: [
    { id: 'mvp-shipped', amount: new Decimal('25000'),  confirmer: sponsorAdmin },
    { id: '1k-users',    amount: new Decimal('50000'),  confirmer: sponsorAdmin },
    { id: '10k-users',   amount: new Decimal('100000'), confirmer: sponsorAdmin },
  ],
});
```

Each leg of the multi-leg `AllocationSpec` is gated on a `ConfirmMilestone` choice from the named confirmer.

### Trust-minimized executor

For trust-minimized recurring withdrawals — the employee doesn't want to click withdraw daily but doesn't want to give the company unlimited authority either:

```typescript
const policy = buildDelegatedPolicy({
  delegator: employeeParty,
  executor: acmeStreamsService,
  allowedActions: ['withdraw'],
  rateLimit: { maxExecutionsPerPeriod: 24, periodDuration: { hours: 24 } },
  maxAmountPerExecution: new Decimal('500'),
  expiresAt: endOfFiscalYear,
});

await dappSDK.prepareExecuteAndWait({
  commands: policy.commands,
  actAs: [employeeParty],
});
```

The proxy's executor honors the on-ledger policy bounds. The employee can revoke at any time.

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
