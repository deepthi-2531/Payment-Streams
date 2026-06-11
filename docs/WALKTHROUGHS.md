# Walkthroughs

Annotated step-by-step traces of the three stream variants Canton Payment Streams ships. Each shows the on-ledger contract transitions, the SDK calls that drove them, and the wallet interactions where applicable.

All examples are V2-only (CIP-56 V2 Token Standard, CIP-0112 `AllocationRequest`, CIP-103 wallet auth).

The SDK snippets below assume a configured `CantonStreamsClient` named
`client` (`new CantonStreamsClient({ transportMode, ledgerApiUrl,
actAs })`), carrying either wallet-issued credentials (Path A) or a
service-party signer (Path B). The `Decimal`, `VestingMode`, and
`SettlementMode` symbols are imported from `@canton-streams/sdk` (and
`decimal.js`). See [`integration-guide/`](integration-guide/) for client
setup and the wallet paths.

---

## Walkthrough 1 — `StreamAdmin`: linear vesting

**Scenario:** Alice streams Bob 1200 units of `MyAsset` over 6 months, starting 2026-06-01.

### Step 1 — Create

Alice opens the dashboard, picks **Create stream**, fills in the form, clicks **Create**.

SDK call — the prefunded path is `client.createStream(params)`
(`CreateStreamParams`; see `packages/sdk/src/commands/create.ts`):

```typescript
const { streamId } = await client.createStream({
  streamId: `vest-${Date.now()}`,
  sender: alice,
  recipient: bob,
  totalDeposited: new Decimal('1200'),
  startTime: new Date('2026-06-01'),
  endTime: new Date('2026-12-01'),
  vestingMode: { mode: VestingMode.Linear },
  settlementMode: SettlementMode.TokenStandardCustody,
  instrumentRef: myAssetRef,            // concrete CIP-56 V2 instrument
  fundingReference: walletFundingRef,   // from the wallet's V2 allocation step
  escrowOperator: escrowOperatorParty,
  cancellable: true,
});
```

The client carries Alice's wallet-issued credentials (Path A) or a
service-party signer (Path B); `createStream` submits the create that
emits the underlying CIP-0112 `AllocationRequest`.

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

SDK call — the recipient accepts with `client.acceptStream(sender,
streamId)` (Bob's client; see `packages/sdk/src/client.ts`):

```typescript
const { escrowContractId } = await client.acceptStream(alice, streamId);
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

Acme creates a non-prefunded flow funded for one period at a time. The
real surface is `client.createFlow(params)` / `buildFlowCreate`
(`CreateFlowParams`; see `packages/sdk/src/commands/flow.ts`). `flowRate`
is tokens per microsecond and `fundedAmount` is the initial funded
balance — there is no `streamType` / `fundingPerPeriod` field:

```typescript
const { streamId } = await client.createFlow({
  sender: bob,
  recipient: acme,
  escrowOperator: escrowOperatorParty,
  instrumentRef: usdcxRef,                            // CIP-56 V2 instrument
  flowRate: new Decimal('50').div(30 * 86_400_000_000), // ~50 USDCx / 30 days
  fundedAmount: new Decimal('50'),                    // first period's funding
  // startTime defaults to now; streamId is generated when omitted.
});
```

On-ledger creates a `StreamFlow` with an iterated allocation:
`nextIterationFunding = 50 USDCx`. For the full create → top-up →
withdraw → pause/resume → stop lifecycle, see
[`integration-guide/non-prefunded-flow.md`](integration-guide/non-prefunded-flow.md).

### Step 2 — Iterate

At the end of the month, the proxy settles for the actual usage (say $47.23):

```
exercise Allocation_Settle with
  amount               = 47.23
  nextIterationFunding = Some 52.00     -- next month's expected bill
```

On-chain: Bob's funding rolls forward; Acme receives 47.23; the iteration counter increments.

If Bob hasn't topped up enough for next month, the sender can top up the
funded balance between iterations with `client.topUpFlow`:

```typescript
await client.topUpFlow(bob, streamId, {
  topUpAmount: new Decimal('52'),
  settlementReference: `${streamId}:top-up-2`,
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

Milestone streams are **admin-driven** — the SDK has no first-class
milestone-create method. The path is the Daml `MilestoneAdmin` template
(`packages/daml/main/daml/CantonStreams/Stream/MilestoneAdmin.daml`):
the **operator creates** a `MilestoneAdmin` recording the milestone list,
then the **sender exercises** `AllocationFactory_Allocate` with one
`TransferLegSide` per milestone (summing to `totalDeposited`,
`committed=True`, `nextIterationFunding=None`). The operator binds the
resulting allocation cid with `Bind_Allocation`.

```
-- Operator creates the observability/admin contract
create MilestoneAdmin with
  streamId, sender = sponsorTreasury, recipient = projectRecipient,
  operator = sponsorAdmin, instrumentRef = usdcxRef,
  milestones =
    [ Milestone with name = "mvp-shipped"; amount = 25000.0; ...
    , Milestone with name = "1k-users";    amount = 25000.0; ...
    , Milestone with name = "10k-users";   amount = 50000.0; ... ]
  totalDeposited = 100000.0; ...

-- Sender's wallet then approves ONE multi-leg AllocationFactory_Allocate
-- (committed=True) covering all three legs.
```

On-ledger this is a single multi-leg V2 `Allocation` — one
`TransferLegSide` per milestone — so the sender's wallet renders **one**
funding prompt for the whole program.

### Step 2 — Confirm milestone

When the project ships its MVP, the operator settles that leg with the
standard V2 `Allocation_Settle` (using the milestone's `name` as the
`transferLegId`), then records the confirmation on the admin contract
with `Confirm_Milestone`:

```
-- Operator settles the leg via the V2 Allocation, then records it:
exercise milestoneAdminCid Confirm_Milestone with
  milestoneName = "mvp-shipped"
```

The project recipient receives 25,000 USDCx. (Confirm/cancel on
`MilestoneAdmin` are operator-controlled bookkeeping over the
authoritative V2 `Allocation` — consumers reconcile against the
allocation, not the admin record.)

### Step 3 — Optional: claim residual

If a milestone is never confirmed, unsettled legs release back to the
sender when the allocation is cancelled (`Allocation_Cancel`); the
operator records it with `Mark_Cancelled_Milestone_Admin`.

---

## Walkthrough 4 — Bulk creation

**Scenario:** AcmeCo creates 250 simultaneous vesting streams (one per employee) with one signature.

Use `client.createBatch({ streams })` — each entry is a full
`CreateStreamParams` (`CreateBatchParams`; see
`packages/sdk/src/commands/create.ts`):

```typescript
const { streamIds } = await client.createBatch({
  streams: employees.map((emp) => ({
    streamId: `vest-${emp.id}`,
    sender: treasury,
    recipient: emp.party,
    totalDeposited: emp.monthlySalary,
    startTime,
    endTime,
    vestingMode: { mode: VestingMode.Linear },
    settlementMode: SettlementMode.TokenStandardCustody,
    instrumentRef: usdcxRef,
    fundingReference: emp.walletFundingRef,
    escrowOperator: escrowOperatorParty,
    cancellable: false,
  })),
});
```

On-ledger: a single `BatchCreateRequest` contract exercises `ExecuteBatch`, fan-out-creating 250 `AllocationRequest` contracts in one transaction. Employees see them in their inboxes; each accepts independently.

---

## Walkthrough 5 — Cancellation

### Sender cancel (cancellable streams only)

```typescript
await client.cancel(sender, streamId);
```

On-chain: a single transaction settles the recipient's accrued-to-now amount, refunds the remainder to the sender, and archives the `Allocation`.

### Mutual cancel

Both sender and recipient must sign, so the client's `actAs` must cover
both parties (a co-hosted client or an operator-orchestrated submission):

```typescript
// actAs must include both sender and recipient for the mutual-cancel choice.
await client.mutualCancel(sender, streamId);
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
