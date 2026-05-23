# Settlement Mode Reference (V2-only)

As of 0.2.8, Canton Payment Streams ships a single supported settlement mode: **`TokenStandardCustody`**.

All on-ledger settlement uses the **CIP-56 V2 Token Standard** via the **CIP-0112 `AllocationRequest`** pattern. The legacy `NumericLegacy`, `UtilityHoldingCustody`, `LocalAssetCustody`, and `Delegated` settlement modes from earlier releases have been removed from the live code path. The `SettlementMode` enum in `@canton-streams/sdk` retains those names so persisted requests don't break to parse, but submitting a request with any value other than `TokenStandardCustody` returns a runtime error.

This page is now a thin pointer to where the real V2 documentation lives.

---

## TokenStandardCustody

**Pick this for:** any CIP-56-compliant asset — Canton Coin, USDCx, future V2-native instruments.

**How it works:** The dApp builds a V2 `AllocationRequest` (V1/V2 dual-interface per CIP-0112 §5). The recipient's wallet accepts; this atomically locks the sender's funding against the escrow operator via `AllocationFactory_Allocate(committed=True)`. Per accrual interval, `Allocation_ExecuteTransfer` settles the next leg.

**Capability negotiation:** the SDK reads `config/asset-registry.json` for the target asset and uses `getAssetCapabilities(instrumentRef)` to pick the right adapter:

- `allocationsV2 && transfersV2` → V2 multi-leg, batch settlement, lock-in-place custody, TransferEventsV2-driven advancement
- otherwise → V1 single-leg AllocationRequest

dApp code does not branch by asset name. When an asset is upgraded from V1 to V1+V2, only the registry entry needs to change.

**Stream variant per use case:**

| Use case | Daml template |
|---|---|
| Vesting / LP rewards / treasury distribution (bounded term, prefunded) | `Stream.StreamAdmin` |
| Subscription / metered billing / open-ended retainer | `Stream.StreamFlow` + `Stream.StreamFlowAdmin` |
| Grant disbursement / KPI-gated unlock | `Stream.MilestoneAdmin` |

All three settle via the same V2 path — wallet integration is identical.

**Where to read more:**

- [allocation-request-pattern.md](allocation-request-pattern.md) — full lifecycle trace + interop notes
- [cip-56-v2-types-reference.md](cip-56-v2-types-reference.md) — V2 Token Standard type reference
- [per-asset-config.md](per-asset-config.md) — `config/asset-registry.json` schema
- [wallet-gateway-api-reference.md](wallet-gateway-api-reference.md) — wallet-gateway server-side API reference
- [cip-103-walkthrough.md](cip-103-walkthrough.md) — dApp ↔ wallet JSON-RPC walkthrough
- [../WALKTHROUGHS.md](../WALKTHROUGHS.md) — annotated end-to-end stream lifecycles
