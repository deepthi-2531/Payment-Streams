# CIP-56 V2 Type Reference

This page summarizes the V2 allocation vocabulary used by Canton Payment
Streams. Upstream `canton-network/splice` is the source of truth; re-check
the upstream Token Standard packages before cutting a release.

## Choice Vocabulary

| Operation | V2 choice |
| --- | --- |
| Accept allocation request | `AllocationRequest_Accept` |
| Reject allocation request | `AllocationRequest_Reject` |
| Withdraw allocation request | `AllocationRequest_Withdraw` |
| Create allocation | `AllocationFactory_Allocate` |
| Settle allocation | `Allocation_Settle` |
| Cancel allocation | `Allocation_Cancel` |
| Withdraw allocation | `Allocation_Withdraw` |
| Batch settle | `SettlementFactory_SettleBatch` |

`Allocation_ExecuteTransfer` is not part of the V2 surface.

## Core View Shapes

### AllocationRequestView

```daml
data AllocationRequestView = AllocationRequestView with
    originalRequestCid : Optional (ContractId AllocationRequest)
    settlement : SettlementInfo
    allocations : [AllocationSpecification]
    requestedAt : Time
    settleAt : Optional Time
    availableActions : Map AllocationRequestAction [[Party]]
    meta : Metadata
```

### AllocationView

```daml
data AllocationView = AllocationView with
    originalAllocationCid : Optional (ContractId Allocation)
    settlement : SettlementInfo
    allocation : AllocationSpecification
    holdingCids : [ContractId Holding]
    createdAt : Time
    numIterations : Int
    expiresAt : Optional Time
    availableActions : Map AllocationAction [[Party]]
    meta : Metadata
```

### SettlementInfo

```daml
data SettlementInfo = SettlementInfo with
    executors : [Party]
    id : Text
    cid : Optional AnyContractId
    meta : Metadata
```

### AllocationSpecification

```daml
data AllocationSpecification = AllocationSpecification with
    admin : Party
    authorizer : Account
    transferLegSides : [TransferLegSide]
    settlementDeadline : Optional Time
    nextIterationFunding : Optional (TextMap Decimal)
    committed : Bool
    meta : Metadata
```

## Streaming Implications

- Committed allocations (funds cannot be withdrawn before the settlement
  deadline) describe the upstream V2 vocabulary and Daml template design. On the
  live deployment, settlement runs through a disclosed operator-custodial escrow
  path (direct CC holding delivery): funds are custodied by the commingled
  operator rather than locked on-ledger until a deadline. The on-chain
  committed-allocation `Allocation_Settle` leg is DSO-gated on this participant
  and is not currently exercised.
- `nextIterationFunding` enables repeated settlement across stream periods.
- `numIterations` is the allocation-chain counter used for off-chain
  correlation.
- The dApp and executor prepare stream-specific commands; generic wallets
  should still show the typed V2 views and ledger arguments.

## Sources

- `https://github.com/canton-network/splice/tree/main/token-standard`
- `token-standard/splice-api-token-allocation-v2`
- `token-standard/splice-api-token-allocation-request-v2`
