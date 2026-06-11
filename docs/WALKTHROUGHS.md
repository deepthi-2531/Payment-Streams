# Walkthroughs

Annotated step-by-step traces of the three stream variants Canton Payment Streams ships. Each shows the on-ledger contract transitions, the SDK calls that drove them, and the wallet interactions where applicable.

All examples are V2-only (CIP-56 V2 Token Standard, CIP-0112 `AllocationRequest`, CIP-103 wallet auth).

---

## Walkthrough 1 — `StreamAdmin`: linear vesting

**Scenario:** Alice streams Bob 1200 units of `MyAsset` over 6 months, starting 2026-06-01.

### Step 1 — Create

Alice opens the dashboard, picks **Create stream**, fills in the form, clicks **Create**.

SDK call:

```typescript
const request = buildAllocationRequest({
  sender: alice,
  recipient: bob,
  asset: { instrumentId: 'MyAsset', admin: myAssetAdmin },
  totalAmount: new Decimal('1200'),
  vestingMode: { mode: VestingMode.Linear },
  startTime: new Date('2026-06-01'),
  endTime: new Date('2026-12-01'),
  settlementMode: SettlementMode.TokenStandardCustody,
  cancellable: true,
});

await dappSDK.prepareExecuteAndWait({
  commands: request.commands,
  actAs: [alice],
});
```

On-ledger:

```
+-----------------------------------+
| AllocationRequest                 |
|   sender    = Alice               |
|   recipient = Bob                 |
|   spec      = linear 1200 over 6mo|
|   committed = false (not yet)     |
+-----------------------------------+
```

Visible to: Alice, Bob, MyAssetAdmin, and the escrow operator. Dashboard shows the stream as awaiting wallet funding approval.

### Step 2 — Approve funding in the wallet

Bob opens his dashboard and sees the incoming stream. The dashboard can surface the request and deep-link into a capable wallet, but it does not create a separate Streams-level accept contract. The actual approval is the token-standard wallet action for the underlying CIP-0112 `AllocationRequest`.

SDK call:

```typescript
const accept = buildAcceptAllocationRequest({ requestContractId: req.contractId });
await dappSDK.prepareExecuteAndWait({
  commands: accept.commands,
  actAs: [bob],
});
```

On-ledger, this exercises `AllocationFactory_Allocate(committed=True)`, which atomically:

1. Archives or completes the token-standard `AllocationRequest`
2. Creates the committed `Allocation` contract
3. Locks Alice's 1200 units of `MyAsset` against the escrow operator

```
+-----------------------------------+
| Allocation                        |
|   sender    = Alice               |
|   recipient = Bob                 |
|   spec      = linear 1200 over 6mo|
|   locked    = 1200 (committed)    |
|   settled   = 0                   |
+-----------------------------------+
```

After the wallet action commits, the dashboard refreshes the stream to **Active**. For hosted wallet layers that cannot submit `prepareExecuteAndWait` directly, the user completes the approval in the wallet UI and returns to the dashboard.

### Step 3 — Settle (per accrual interval)

The proxy's `TransferEventsV2` subscriber wakes up every minute. For each `Active` stream, it computes the accrued amount since the last settle and exercises `Allocation_Settle`.

After 1 day:

```
linearAccrual = totalAmount × elapsed / duration
              = 1200 × 86400s / (6 × 30 × 86400s)
              = 1200 × 1/180
              = 6.6666666667     (Daml LF ROUND_HALF_EVEN, 10 places)
```

The proxy submits:

```
exercise Allocation_Settle with
  amount = 6.6666666667
  side   = SenderSide
```

On-chain:

1. 6.6666666667 units move from the escrow lock to Bob's account
2. `Allocation.settled` increments
3. A `TransferEventsV2` event is emitted

Bob's wallet shows the holding balance increase.

### Step 4 — Completion

After 6 months (at `endTime`), the accrual reaches 1200. The next settle drains the lock; `Allocation` archives; stream marks `Completed`.

Total Bob received: exactly 1200 (Daml accrual math is exact under V2 atomic settlement).

---

## Walkthrough 2 — `StreamFlow`: rolling subscription

> **Non-prefunded flows:** for the full `StreamFlow` reference — the
> create → top-up → withdraw → pause/resume → stop lifecycle, the SDK
> builders, the `/api/flows` routes, the dashboard actions, and the
> `devnet-streamflow-probe.mjs` probe — see
> [`integration-guide/non-prefunded-flow.md`](integration-guide/non-prefunded-flow.md).

**Scenario:** Acme charges Bob a recurring infrastructure-billing subscription. Acme bills Bob ~$50/month, but the amount varies based on usage.

### Step 1 — Create

Acme creates a flow stream funded for one period at a time:

```typescript
const request = buildAllocationRequest({
  sender: bob,
  recipient: acme,
  asset: { instrumentId: 'USDCx', admin: usdcxAdmin },
  totalAmount: new Decimal('50'),
  vestingMode: { mode: VestingMode.Linear },
  startTime: monthStart,
  endTime: monthEnd,
  streamType: 'flow',
  settlementMode: SettlementMode.TokenStandardCustody,
  fundingPerPeriod: new Decimal('50'),
  periodDuration: { days: 30 },
});
```

On-ledger creates a `StreamFlow` with an iterated allocation: `nextIterationFunding = 50 USDCx`.

### Step 2 — Iterate

At the end of the month, the proxy settles for the actual usage (say $47.23):

```
exercise Allocation_Settle with
  amount               = 47.23
  nextIterationFunding = Some 52.00     -- next month's expected bill
```

On-chain: Bob's funding rolls forward; Acme receives 47.23; the iteration counter increments.

If Bob hasn't topped up enough for next month, the proxy can call `TopUp` between iterations:

```typescript
await dappSDK.prepareExecuteAndWait({
  commands: topUpRequest.commands,
  actAs: [bob],
});
```

### Step 3 — Terminate

When Bob cancels his subscription:

```
exercise Allocation_Settle with
  amount               = <final period accrual>
  nextIterationFunding = None             -- terminate the chain
```

The Allocation completes. Any unused funding refunds to Bob.

---

## Walkthrough 3 — `MilestoneAdmin`: KPI-gated milestones

**Scenario:** AcmeSponsor streams $100k to a project, disbursed in three tranches gated on KPIs.

### Step 1 — Create

```typescript
const request = buildAllocationRequest({
  sender: sponsorTreasury,
  recipient: projectRecipient,
  asset: { instrumentId: 'USDCx', admin: usdcxAdmin },
  streamType: 'milestone',
  totalAmount: new Decimal('100000'),
  milestones: [
    { id: 'mvp-shipped', amount: new Decimal('25000'),  confirmer: sponsorAdmin },
    { id: '1k-users',    amount: new Decimal('25000'),  confirmer: sponsorAdmin },
    { id: '10k-users',   amount: new Decimal('50000'),  confirmer: sponsorAdmin },
  ],
  settlementMode: SettlementMode.TokenStandardCustody,
});
```

On-ledger creates a multi-leg `AllocationSpec` — one leg per milestone, each gated on the named confirmer.

### Step 2 — Confirm milestone

When the project ships its MVP, the sponsor admin confirms:

```typescript
await dappSDK.prepareExecuteAndWait({
  commands: confirmMilestone({ milestoneId: 'mvp-shipped' }),
  actAs: [sponsorAdmin],
});
```

Triggers `Allocation_Settle` for that leg. The project recipient receives 25,000 USDCx.

### Step 3 — Optional: claim residual

If a milestone is never confirmed by the deadline, the sender can claim the residual refund via the `ClaimResidualRefund` choice.

---

## Walkthrough 4 — Bulk creation

**Scenario:** AcmeCo creates 250 simultaneous vesting streams (one per employee) with one signature.

```typescript
const requests = employees.map((emp) => ({
  recipient: emp.party,
  totalAmount: emp.monthlySalary,
  vestingMode: { mode: VestingMode.Linear },
  startTime,
  endTime,
  settlementMode: SettlementMode.TokenStandardCustody,
}));

const batch = batchCreate(requests, { sender: treasury, asset: usdcxRef });

await dappSDK.prepareExecuteAndWait({
  commands: batch.commands,
  actAs: [treasury],
});
```

On-ledger: a single `BatchCreateRequest` contract exercises `ExecuteBatch`, fan-out-creating 250 `AllocationRequest` contracts in one transaction. Employees see them in their inboxes; each accepts independently.

---

## Walkthrough 5 — Cancellation

### Sender cancel (cancellable streams only)

```typescript
await dappSDK.prepareExecuteAndWait({
  commands: cancelStream({ streamId }),
  actAs: [sender],
});
```

On-chain: a single transaction settles the recipient's accrued-to-now amount, refunds the remainder to the sender, and archives the `Allocation`.

### Mutual cancel

Both sides must agree:

```typescript
// Sender side
await dappSDK.prepareExecuteAndWait({
  commands: proposeMutualCancel({ streamId }),
  actAs: [sender],
});

// Recipient side, separately
await dappSDK.prepareExecuteAndWait({
  commands: acceptMutualCancel({ streamId }),
  actAs: [recipient],
});
```

Atomically settles the accrued amount to the recipient and the remainder to the sender.

---

## What you should observe end-to-end

For a healthy integration, all of the following are true:

| Layer | Observable signal |
|---|---|
| Dashboard | Stream visible to both sender and recipient with current `accrued` / `available` / `escrowed` |
| Proxy | `GET /api/streams` returns the stream; `/history` shows ledger events with `source: "ledger"` |
| Wallet | Recipient's holding balance increases after each settle |
| Ledger | `Allocation.settled` increases monotonically; `lock` decreases mirror-image; no unaccounted balance |
| Metrics | `scripts/query-adoption-metrics.mjs` includes the stream in its per-asset count |

If any of these is missing, start with the health checks in [DEPLOYMENT.md](DEPLOYMENT.md).
