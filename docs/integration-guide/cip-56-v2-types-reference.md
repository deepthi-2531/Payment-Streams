# CIP-56 V2 — Verified Type Reference

> **Source of truth** (user-confirmed, May 2026):
>
> * **V1**: published spec at `https://docs.sync.global/app_dev/api/splice-api-token-allocation-v1/` (and sibling pages for AllocationRequestV1, AllocationInstructionV1, MetadataV1, HoldingV1).
> * **V2**: the `token-standard-v2-upcoming` branch of `canton-network/splice` — there is no V2 page on docs.sync.global yet. Direct file URLs:
>   * `https://raw.githubusercontent.com/canton-network/splice/token-standard-v2-upcoming/token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml`
>   * `https://raw.githubusercontent.com/canton-network/splice/token-standard-v2-upcoming/token-standard/splice-api-token-allocation-request-v2/daml/Splice/Api/Token/AllocationRequestV2.daml`
>
> When this reference disagrees with upstream, upstream wins. Re-verify before any release.
>
> **V1 ≠ V2 vocabulary** — the same logical operation has different choice names in V1 and V2 (e.g. settle = V1 `Allocation_ExecuteTransfer` / V2 `Allocation_Settle`). See STR-89 for the full V1-vs-V2 contrast table.

## Why this matters

Yesterday's STR-66/68/69 work added stub modules at `Settlement/Stubs/AllocationRequestV{1,2}` and the view-builder helpers in `Settlement/AllocationBridge.daml`. They were written from inference — not from the published spec. Now that I have the published spec, here are the deltas.

## Files in scope

| File on splice repo | Our stub | Status |
|---|---|---|
| `token-standard/splice-api-token-allocation-request-v2/daml/Splice/Api/Token/AllocationRequestV2.daml` | `Settlement/Stubs/AllocationRequestV2.daml` | **shape diverges; rewrite needed** |
| `token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml` | `Settlement/Stubs/AllocationV2.daml` | **shape diverges; rewrite needed** |
| `token-standard/splice-api-token-allocation-request-v1/daml/Splice/Api/Token/AllocationRequestV1.daml` | `Settlement/Stubs/AllocationRequestV1.daml` | re-verify against V1 spec |
| `token-standard/splice-api-token-allocation-v1/daml/Splice/Api/Token/AllocationV1.daml` | `Settlement/Stubs/AllocationV1.daml` | re-verify |

## V2 — verified shapes

### `AllocationRequestView`

```daml
data AllocationRequestView = AllocationRequestView with
    originalRequestCid : Optional (ContractId AllocationRequest)
    settlement : SettlementInfo
    allocations : [AllocationSpecification]    -- NOT transferLegs : Map
    requestedAt : Time                          -- on the view, not on SettlementInfo
    settleAt : Optional Time                    -- on the view
    availableActions : Map AllocationRequestAction [[Party]]   -- MISSING from our stubs
    meta : Metadata
```

### `AllocationRequestAction`

```daml
data AllocationRequestAction
    = ARA_Accept
    | ARA_Reject
    | ARA_Custom with id : Text
```

Note: the prefix is `ARA_` (AllocationRequestAction), not `AA_`. The Map's value is `[[Party]]` — a disjunction of conjunctions ("either A signs alone OR (B AND C) sign jointly").

### `AllocationView`

```daml
data AllocationView = AllocationView with
    originalAllocationCid : Optional (ContractId Allocation)
    settlement : SettlementInfo
    allocation : AllocationSpecification        -- single, NOT a list
    holdingCids : [ContractId Holding]
    createdAt : Time
    numIterations : Int                         -- ← iterated allocation counter is here!
    expiresAt : Optional Time
    availableActions : Map AllocationAction [[Party]]
    meta : Metadata
```

### `AllocationAction`

```daml
data AllocationAction
    = AA_Settle
    | AA_Cancel
    | AA_Withdraw
    | AA_Custom with id : Text
```

**Two separate action types**:
- `AllocationRequestAction` (`ARA_*`) — on the request contracts
- `AllocationAction` (`AA_*`) — on the allocation contracts (the per-party authorization)

### `SettlementInfo`

```daml
data SettlementInfo = SettlementInfo with
    executors : [Party]              -- ← LIST, not single Party
    id : Text
    cid : Optional AnyContractId
    meta : Metadata
```

**Notable**: no `allocateBefore` / `settleBefore` / `requestedAt` fields. `requestedAt` lives on `AllocationRequestView`; settlement deadlines live on `AllocationSpecification.settlementDeadline`.

### `AllocationSpecification`

```daml
data AllocationSpecification = AllocationSpecification with
    admin : Party                              -- the asset admin
    authorizer : Account                       -- V2 Account with provider field
    transferLegSides : [TransferLegSide]
    settlementDeadline : Optional Time
    nextIterationFunding : Optional (TextMap Decimal)
                                                -- keyed by instrumentId, value = amount
                                                -- None = no iteration; Some {} = iteration enabled with no reserve
    committed : Bool                           -- if True, authorizer cannot withdraw before deadline
    meta : Metadata
```

### `TransferLegSide`

```daml
data TransferLegSide = TransferLegSide with
    transferLegId : Text
    side : TransferSide                        -- SenderSide | ReceiverSide
    otherside : Account                        -- the OTHER party's account
    amount : Decimal
    instrumentId : Text                        -- ← plain Text, not InstrumentIdV2
    meta : Metadata

data TransferSide = SenderSide | ReceiverSide
```

**The asset admin moves to `AllocationSpecification.admin`**; `instrumentId` is just the local Text identifier within that admin's namespace.

## Notable deltas vs. our current stubs

| Field | Our stub (wrong) | Verified V2 |
|---|---|---|
| View type name | `AllocationRequest_View` | `AllocationRequestView` |
| View `transferLegs` | `Map Text TransferLegSide` | `allocations : [AllocationSpecification]` |
| Settlement `executor` | `Party` (singular) | `executors : [Party]` (plural) |
| Settlement deadlines | on `SettlementInfo` | on `AllocationSpecification.settlementDeadline` + `AllocationRequestView.settleAt` |
| View `requestedAt` | on `SettlementInfo` | on `AllocationRequestView` |
| `TransferLegSide.instrumentId` | `InstrumentIdV2` | `Text` (admin is captured separately at AllocationSpec level) |
| `TransferLegSide.sender/receiver` | both fields present | `side` + `otherside : Account` (the relative-side model) |
| `availableActions` | absent from view | required: `Map ARA [[Party]]` |
| Action types | none | `AllocationRequestAction` (ARA_*) + `AllocationAction` (AA_*) |
| `nextIterationFunding` | on `Allocation_Settle` choice arg | on `AllocationSpecification` itself |
| `numIterations` | manually tracked by StreamFlow | built into `AllocationView` |

## Implications for our existing code

1. **Stubs need a structural rewrite**. The current stubs would not swap cleanly to real imports — the field names and structure differ.
2. **`AllocationBridge.buildV2View` produces the wrong shape**. The function should return `AllocationRequestView`, not our local `AllocationRequest_View`. Field renames + restructure required.
3. **`StreamEscrow` / `StreamFlow` / `MilestoneEscrow` `interface instance ... where view = ...` blocks need updating** to produce the correct view shape after stubs are corrected.
4. **`SettlementInfo.executors` is a list** — our code's `executor : Party` assumption needs to accept a list (defaulting to `[escrowOperator]` for our streams).
5. **`StreamFlow.numIterations` already exists on our template; `AllocationView.numIterations` will overlap**. Once real Allocation contracts are created in STR-87, the contract has the authoritative counter; our template counter becomes a mirror that updates on each settle event.
6. **The relative-side model (`side` + `otherside`)** is more elegant than separate `sender`/`receiver` fields. The implementation needs to convert at the boundary.

## Sources

- `canton-network/splice@token-standard-v2-upcoming` branch
- `token-standard/splice-api-token-allocation-request-v2/daml/Splice/Api/Token/AllocationRequestV2.daml`
- `token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml`
- Both files fetched May 2026 via raw.githubusercontent.com
