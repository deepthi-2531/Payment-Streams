# AllocationRequest pattern (V2-only)

> **Status (May 2026 / STR-79 V2-only pivot)**: this library supports the
> CIP-56 Token Standard V2 only. V1 was dropped — see [STR-79 decision](https://linear.app/bitdynamics/issue/STR-79)
> for the rationale.
>
> Per [CIP-0112 §5 Backwards Compatibility](https://github.com/canton-foundation/cips/blob/main/cip-0112/cip-0112.md#5-backwards-compatibility),
> V1 assets are expected to publish V2 interfaces alongside V1 (dual-
> implementation). Once an asset advertises V2 in its `supportedApis`
> metadata field, this library integrates with it automatically. V1-only
> assets are not supported because the streaming primitive requires the
> V2 committed + iterated allocation primitive, which V1 has no equivalent for.

## The pattern in one diagram

```
┌─────────────┐    1. emit AllocationRequestV2     ┌──────────────────┐
│  Operator   │ ─────────────────────────────────▶│ AllocationRequest│
│   (admin)   │                                     │      (V2)        │
└──────┬──────┘                                     └────────┬─────────┘
       │                                                     │
       │ creates StreamEscrow                                │ sender wallet
       │ admin contract                                      │ sees the request
       ▼                                                     ▼
┌─────────────┐    2. AllocationFactory_Allocate   ┌──────────────────┐
│ StreamEscrow│                                     │ Sender's wallet  │
│  (admin)    │                                     │ (committed=True, │
│             │                                     │  nextIteration   │
│             │                                     │   Funding=Some)  │
└──────┬──────┘                                     └────────┬─────────┘
       │                                                     │
       │                                                     ▼
       │                                          ┌──────────────────┐
       │                                          │   Allocation     │
       │                                          │     (V2)         │
       │                                          │  committed=True  │
       │                                          │  iter 1 of N     │
       │                                          └────────┬─────────┘
       │                                                   │
       │  per accrual period:                              │
       │  3. Allocation_Settle with                        │
       │     nextIterationFunding = remaining              ▼
       │                                          ┌──────────────────┐
       │  Sync_Iteration ─────────────────────────│ Operator's       │
       │                                          │ executor (SDK)   │
       │                                          └────────┬─────────┘
       │                                                   │
       │  4. final iteration:                              │
       │     nextIterationFunding = None                   ▼
       │     → chain terminates              ┌────────────────────────┐
       │                                     │ Recipient holdings     │
       └──────────────── Mark_Completed ─────│ (atomic per-period     │
                                              │  transfer per settle) │
                                              └────────────────────────┘
```

## Choice vocabulary (V2)

Verified against [`canton-network/splice@token-standard-v2-upcoming`](https://github.com/canton-network/splice/tree/token-standard-v2-upcoming/token-standard):

| Operation | V2 choice | Actor | Where the call originates |
|---|---|---|---|
| Accept request | `AllocationRequest_Accept` | sender | sender wallet (one-shot per stream) |
| Reject request | `AllocationRequest_Reject` | sender / receiver | wallet (UI gap in some current wallets — adopters may need to surface via Ledger API) |
| Withdraw request | `AllocationRequest_Withdraw` | executor | operator-side via SigningProvider |
| Create allocation | `AllocationFactory_Allocate` | sender | sender wallet (committed=True, nextIterationFunding=Some) |
| Settle allocation | `Allocation_Settle` | executor | operator-side; iterates the chain |
| Cancel allocation | `Allocation_Cancel` | sender / receiver | wallet |
| Withdraw allocation | `Allocation_Withdraw` | executor | operator-side |
| Batch settle | `SettlementFactory_SettleBatch` | executor | operator-side; multi-leg / multi-allocation |

**Action enums on the views** (V2):

* `AllocationRequestAction = ARA_Accept | ARA_Reject | ARA_Custom { id : Text }`
* `AllocationAction = AA_Settle | AA_Cancel | AA_Withdraw | AA_Custom { id : Text }`

Per [the CIP-0112 update](https://lists.sync.global/g/cip-discuss/message/743), `_Custom` carries only `id`; display metadata is delivered out-of-band via the view's overall `meta` field.

## The streaming primitive = iterated committed allocation

`AllocationSpecification` carries two fields that make streams natural:

* `committed : Bool` — when `True`, the sender cannot withdraw before `settlementDeadline`. Funds are locked.
* `nextIterationFunding : Optional (TextMap.TextMap Decimal)` — when set, settle produces a **next-iteration `Allocation`** contract with the funding rolled forward.

A payment stream is exactly the iterated case:

1. Sender exercises `AllocationFactory_Allocate(committed=True, nextIterationFunding=Some({CC: 1000}))` — locks 1000 CC for the stream.
2. Per accrual period: operator's SDK executor computes `period_amount` from the vesting math, exercises `Allocation_Settle(leg: 10 CC to recipient, nextIterationFunding=Some({CC: 990}))`. The settle atomically transfers 10 CC + creates next iteration with 990 CC funding.
3. After N periods: operator exercises `Allocation_Settle(nextIterationFunding = None)` — chain terminates.

`Allocation.originalAllocationId` ties all iterations together for off-chain correlation.

## Behavioral interop — what a generic V2 wallet can and cannot do (STR-91)

Earlier framing of this library overclaimed "wallet-agnostic" interop. Be precise about it:

### A wallet that knows ONLY the V2 standard vocabulary CAN

A V2-only wallet — one that implements `Splice.Api.Token.AllocationV2` + `Splice.Api.Token.AllocationRequestV2` and nothing else — can complete the **standard-set lifecycle** for a Canton-Streams stream without any stream-specific code:

* Render an `AllocationRequest` from `AllocationRequestView` (settlement info, allocations list, `availableActions` map)
* Sign `AllocationFactory_Allocate` to create the committed + iterated allocation at stream start
* Sign `AllocationRequest_Accept` / `AllocationRequest_Reject`
* Sign `Allocation_Cancel` to release the committed allocation
* Display `numIterations`, `originalAllocationId`, and the leg list verbatim

This is the **operability** acceptance gate verified by [STR-89](https://linear.app/bitdynamics/issue/STR-89) `V2WalletOnly` scripts.

### A wallet that knows ONLY the V2 standard vocabulary CANNOT

The V2 spec exposes a `_Custom { id : Text }` namespace in both `AllocationRequestAction` and `AllocationAction` (`ARA_Custom` / `AA_Custom`). Per the CIP-0112 update, `_Custom` carries **only** an opaque `id` string — no `description`, no per-action `meta`. A V2 wallet has no semantic knowledge of what any given `id` means.

This means a generic V2 wallet cannot **originate** a stream-specific operation. Specifically:

| Operation | `id` we emit | Who originates the call |
|---|---|---|
| Top up a `StreamFlow` | `ARA_Custom { id = "topup" }` | **dApp UI** must prepare the underlying `AllocationFactory_Allocate` + `SettlementFactory_SettleBatch` self-transfer batch; wallet only signs what the dApp prepared |
| Pause a `StreamFlow` | `ARA_Custom { id = "pause" }` | **dApp UI** must originate the `Pause_Flow_Admin` exercise (no V2 standard primitive maps to "pause future settles") |
| Resume a `StreamFlow` | `ARA_Custom { id = "resume" }` | **dApp UI** must originate the `Resume_Flow_Admin` exercise |
| Confirm a milestone | `ARA_Custom { id = "confirmMilestone:<name>" }` | **dApp UI** originates the per-leg `Allocation_Settle` + `Confirm_Milestone` admin exercise |

What the wallet's UI **does** show: the `id` string verbatim plus the view-level `meta` (e.g. `streamId`, `vestingMode`). A correctly-implemented V2 wallet will surface these as raw fields — the dApp's UI is responsible for translating them into human-readable affordances. The wallet's signing prompt always shows the actual ledger arguments, so a misleading `id` cannot trick a wallet into signing something else.

### Practical implication for integrators

* **End-user dApps** must ship their own UI for `topup` / `pause` / `resume` / `confirmMilestone` — these cannot be driven by clicking the wallet's standard buttons alone.
* **Server-side automation** (treasury cron, billing scheduler) lives in the dApp + operator backend, not in the wallet.
* **Wallet vendors** implementing only V2 standard primitives will support the common case (create + accept + cancel) for free, with no per-asset or per-app code. Stream-specific actions need the dApp.

The wallet-agnostic claim holds for the **majority of stream activity** (creates, cancels, iteration accept-prompts when wallets opt to surface them), but the per-stream-type custom operations need dApp UI.

## Trust model

| Surface | Trust source |
|---|---|
| Standard V2 interface choices (`AllocationFactory_Allocate`, `Allocation_Settle`, etc.) | **Interface-fixed**: wallet renders from typed view fields. Reliable. |
| `meta` / `extraArgs` content + our template choices (`StreamEscrow.Sync_Iteration` etc.) | **dApp-honesty**: wallet must surface raw args alongside any operator-supplied label. |
| Executor's settle calls | **Operator trust**: per the CIP-0112 update, `SettlementFactory_SettleBatch` requires only executor authority. By exercising `AllocationFactory_Allocate(committed=True)`, the sender effectively pre-authorizes the executor's settlement series within the iteration chain. |

## What lives where

* **On-ledger custody**: V2 `Allocation` contracts (standard, not ours). Hold the locked funds. Chain via `originalAllocationId`.
* **On-ledger admin**: our `StreamEscrow` / `StreamFlow` / `MilestoneEscrow` templates. Record metadata, accrual config, sync per-iteration state. Not custody contracts.
* **Off-chain accrual math**: SDK `accrual/executor.ts`. Computes `period_amount` from vesting mode + time.
* **Off-chain settlement orchestration**: proxy's `transfer-events-subscriber.ts`. Reacts to V2 `EventLog_HoldingsChange` events; exercises `Allocation_Settle` via the operator's `SigningProvider` on the Wallet Gateway.

## Reference implementations to mirror

* [`splice-token-test-trading-app-v2/TradingAppV2.daml`](https://github.com/canton-network/splice/blob/token-standard-v2-upcoming/token-standard/examples/splice-token-test-trading-app-v2/daml/Splice/Testing/Apps/TradingAppV2.daml) — canonical V2 app that emits AllocationRequest + drives `SettlementFactory_SettleBatch`. Our `StreamEscrow` admin contract follows the same shape (group transfer legs by authorizer; emit per-authorizer requests; executor batch-settles) — diff: streams iterate, trades don't.
* [`splice-token-standard-v2-test/Tests/TestIteratedSettlement.daml`](https://github.com/canton-network/splice/blob/token-standard-v2-upcoming/token-standard/splice-token-standard-v2-test/daml/Splice/Tests/TestIteratedSettlement.daml) — canonical end-to-end test for committed + iterated allocations. Our streams acceptance test ([STR-89](https://linear.app/bitdynamics/issue/STR-89)) mirrors this pattern using the same `Splice.Testing.TokenStandard.WalletClientV2` fixtures.

## Related docs

* [`per-asset-config.md`](./per-asset-config.md) — asset registry format (V2-only)
* [`cip-56-v2-types-reference.md`](./cip-56-v2-types-reference.md) — verified V2 type listing
* [`wallet-gateway-api-reference.md`](./wallet-gateway-api-reference.md) — JSON-RPC dApp API the SDK signs through
* [`THREAT-MODEL.md`](../THREAT-MODEL.md) — full threat-model packet for the audit firm
