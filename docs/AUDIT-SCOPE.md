# Independent Audit Scope

Scope and preparation package for an independent Daml/Canton
smart-contract review of Canton Payment Streams.

---

## Purpose

This document is the **preparation for an external review**, not a
review report. An independent reviewer flagged that the project already
maintains an internal threat model ([docs/THREAT-MODEL.md](THREAT-MODEL.md))
and an internal findings register ([docs/SECURITY-FINDINGS.md](SECURITY-FINDINGS.md)),
but did not have a single artifact that frames the scope of an
*external* smart-contract review.

This file defines that scope: the in-scope components, the properties a
reviewer should verify, what is out of scope, and the checklist a
reviewer follows to build, test, and accept the work.

> **This is the scope and prep for a review to be performed by an
> independent reviewer.** The external engagement itself — selecting a
> reviewer, contracting, and running the review — is a procurement step
> the maintainers will run. No external audit has been performed yet.
> Any findings recorded to date are from the project's own internal
> review (see [docs/SECURITY-FINDINGS.md](SECURITY-FINDINGS.md)).

---

## In-Scope Components

The review covers the on-ledger Daml and the off-ledger trust boundary
that drives settlement. File pointers are given so the reviewer can go
straight to the source.

### Escrow templates

| Component | File | Notes |
|---|---|---|
| `StreamEscrow` (prefunded bilateral stream) | [`packages/daml/main/daml/CantonStreams/Stream/Escrow.daml`](../packages/daml/main/daml/CantonStreams/Stream/Escrow.daml) | Native lifecycle choices (`Withdraw_Stream`, `Cancel_Stream`, `MutualCancel_Stream`, `Renew_Stream`, `Complete_Stream`, `GetStreamInfo`) plus the V2 `AllocationRequest` read interface. |
| `StreamAdmin` (V2 allocation admin path) | [`packages/daml/main/daml/CantonStreams/Stream/StreamAdmin.daml`](../packages/daml/main/daml/CantonStreams/Stream/StreamAdmin.daml) | Sender-signed metadata/observability contract; the authoritative V2 allocation entry point. |
| `MilestoneEscrow` / `MilestoneAdmin` | [`packages/daml/main/daml/CantonStreams/Stream/MilestoneEscrow.daml`](../packages/daml/main/daml/CantonStreams/Stream/MilestoneEscrow.daml), [`MilestoneAdmin.daml`](../packages/daml/main/daml/CantonStreams/Stream/MilestoneAdmin.daml) | Multi-leg release flow; V2 multi-leg `AllocationSpecification` / `SettlementFactory_SettleBatch`. |
| Accrual math | [`packages/daml/main/daml/CantonStreams/Stream/Accrual.daml`](../packages/daml/main/daml/CantonStreams/Stream/Accrual.daml) | `computeAccrued`, `withdrawable`, `refundable`, `checkInvariant`, per-vesting-mode accrual curves. |
| Numeric settlement adapter | [`packages/daml/main/daml/CantonStreams/Settlement/Adapter.daml`](../packages/daml/main/daml/CantonStreams/Settlement/Adapter.daml) | `EscrowBalance`, `splitEscrow` arithmetic used by the native lifecycle path. |
| V1-compatibility deferred path (`HoldingEscrow` / `LocalAssetEscrow`) | [`packages/daml/main/daml-finance-deferred/HoldingEscrow.daml`](../packages/daml/main/daml-finance-deferred/HoldingEscrow.daml), [`LocalAssetEscrow.daml`](../packages/daml/main/daml-finance-deferred/LocalAssetEscrow.daml), [`HoldingAdapter.daml`](../packages/daml/main/daml-finance-deferred/HoldingAdapter.daml), [`CreateLocalAssetStream.daml`](../packages/daml/main/daml-finance-deferred/CreateLocalAssetStream.daml) | **Deferred** physical-custody escrow modules, not built into the shipped `canton-streams` DAR. In scope for review of the `getTime` guards and authority model only; flagged as not active in the V2-only release. |

### StreamFlow (rolling top-up)

| Component | File | Notes |
|---|---|---|
| `StreamFlow` | [`packages/daml/main/daml/CantonStreams/Stream/StreamFlow.daml`](../packages/daml/main/daml/CantonStreams/Stream/StreamFlow.daml) | Rolling stream with `TopUp_Flow`, `Withdraw_Flow`, `Pause_Flow`, `Resume_Flow`, `Stop_Flow`. V2 iterated allocation. |
| `StreamFlowAdmin` | [`packages/daml/main/daml/CantonStreams/Stream/StreamFlowAdmin.daml`](../packages/daml/main/daml/CantonStreams/Stream/StreamFlowAdmin.daml) | Admin/observability contract for the flow path. |

### DelegatedPolicy (bounded executor delegation)

| Component | File | Notes |
|---|---|---|
| `DelegatedPolicy` + `PolicyExecutionState` + `ExecutionLog` | [`packages/daml/main/daml/CantonStreams/Policy/DelegatedPolicy.daml`](../packages/daml/main/daml/CantonStreams/Policy/DelegatedPolicy.daml) | On-ledger bounded authority: `active`, `expiresAt`, `allowedActions`, `streamFilters`, and `rateLimit` (per-execution cap, cooldown, per-period count). Append-only audit log. |
| Policy types | [`packages/daml/main/daml/CantonStreams/Policy/Types.daml`](../packages/daml/main/daml/CantonStreams/Policy/Types.daml) | `DelegatedAction`, `RateLimit`. |

### Interfaces and shared types

| Component | File | Notes |
|---|---|---|
| Core types | [`packages/daml/interfaces/daml/CantonStreams/Interface/Types.daml`](../packages/daml/interfaces/daml/CantonStreams/Interface/Types.daml) | `StreamConfig`, `StreamState`, `VestingMode`, `validVestingMode`. |
| Stream interface | [`packages/daml/interfaces/daml/CantonStreams/Interface/Stream.daml`](../packages/daml/interfaces/daml/CantonStreams/Interface/Stream.daml) | `StreamView`, `WithdrawResult`, `CancelResult`. |
| Stream-group interface | [`packages/daml/interfaces/daml/CantonStreams/Interface/StreamGroup.daml`](../packages/daml/interfaces/daml/CantonStreams/Interface/StreamGroup.daml) | Group view types. |

### Settlement adapters and the V2 allocation bridge

| Component | File | Notes |
|---|---|---|
| Allocation bridge | [`packages/daml/main/daml/CantonStreams/Settlement/AllocationBridge.daml`](../packages/daml/main/daml/CantonStreams/Settlement/AllocationBridge.daml) | Shared V2 view-builder helpers: `buildV2View`, `buildSimpleSpec`, `buildSettlementInfoV2`, conservation checks. |
| Numeric adapter | [`packages/daml/main/daml/CantonStreams/Settlement/Adapter.daml`](../packages/daml/main/daml/CantonStreams/Settlement/Adapter.daml) | See escrow table above. |

### Off-ledger trust boundary

The off-ledger services that drive the on-ledger contracts are in scope
*for their interaction with the ledger* (which choices they exercise,
under whose authority, and how they validate ledger events):

| Component | Path | Notes |
|---|---|---|
| REST proxy auth | `packages/proxy/` | JWT/JWKS verification, token-to-party binding, service-token gating for operator actions. |
| TransferEventsV2 subscriber | `packages/proxy/src/transfer-events-subscriber.ts` | Reacts to `Allocation_Settle` events and advances stream state; package-hash + template-id filtering. |
| Executor service | `packages/executor/` | Drives `ExecutePolicy` within the on-ledger `DelegatedPolicy` bounds. |
| Signing providers | `packages/sdk/` SigningProvider adapters | The boundary where the wallet/HSM signs prepared transactions; the dApp never sees private keys. |

---

## Properties To Verify

### Authority / signatory model (who can do what)

The reviewer should confirm that every fund-moving choice is
controller-gated and that no party can exceed its role:

- `Withdraw_Stream` — controller `config.recipient` only.
- `Cancel_Stream` — controller `config.sender`, guarded by
  `config.cancellable`.
- `MutualCancel_Stream` — joint authorization (`config.sender,
  config.recipient`).
- `Renew_Stream` / `Complete_Stream` — controller per the template
  (sender renews; recipient completes).
- `GetStreamInfo` — non-mutating; viewer must be sender, recipient, or a
  listed observer.
- `StreamEscrow` signatories are `config.sender` and `config.recipient`;
  recipient consent and custody authorization for V2 flows are enforced
  by the CIP-56 `AllocationRequest` / `Allocation` lifecycle.
- `DelegatedPolicy` is signed by sender + recipient + executor; the
  executor cannot exceed `allowedActions`, `streamFilters`, or
  `rateLimit`; `PolicyExecutionState` reset requires joint
  sender + executor authority (a sender alone cannot reset counters to
  bypass the rate limit).
- `StreamFlow` controllers: `Withdraw_Flow` (recipient + escrow
  operator), `Stop_Flow` (sender + recipient + escrow operator),
  `Pause_Flow` / `Resume_Flow` (sender).

### Accrual / conservation invariants

Verify the invariants asserted in
[`Accrual.daml`](../packages/daml/main/daml/CantonStreams/Stream/Accrual.daml)
and enforced in the template `ensure` clauses:

1. **Withdrawal bound:** `0 <= totalWithdrawn <= accrued(now) <= totalDeposited`.
2. **Conservation (with dust tolerance):** `refundable + withdrawable +
   totalWithdrawn + dust = totalDeposited`, where dust is bounded by one
   minimum `Decimal` unit and always favors the sender.
3. **Monotonic accrual:** `t1 <= t2 => accrued(t1) <= accrued(t2)` for
   all vesting modes (Linear, CliffLinear, Stepped, RenewableTerm).
4. **Terminal-state finality:** once `Cancelled` / `Completed`, no
   choice can re-activate the stream.
5. **`ensure` guard:** `totalDeposited > 0`, `startTime < endTime`,
   `0 <= totalWithdrawn <= totalDeposited`, `validVestingMode`,
   `escrow.amount >= 0`.

### Time-bound guards

Canton bounds a transaction's record time but does **not** validate a
`Time` *field* passed as a choice argument. Each fund-moving choice must
therefore assert its caller-supplied time against `getTime`. The
reviewer should confirm this guard is present on every:

- `Withdraw_Stream` (`withdrawTime <= now`)
- `Cancel_Stream` and `MutualCancel_Stream` (`cancelTime <= now`)
- `Renew_Stream` (`renewTime <= now`)
- `Complete_Stream` (`completeTime <= now`)
- `Withdraw_Flow` / `Pause_Flow` / `Resume_Flow` / `Stop_Flow`
  (the flow-time argument bounded to `now`)
- `ExecutePolicy` (cooldown, expiry, and period evaluation all use
  `getTime`, never wall-clock)

These guards close the CR-1 / CR-2 class from the internal review (a
recipient passing `withdrawTime = endTime` to drain day one, or a sender
passing `cancelTime = startTime` to claw back vested funds).

### V1/V2 capability negotiation

- The library is **V2-only**: `getAssetCapabilities` /
  `selectAdapter` (`packages/sdk/src/assets/capabilities.ts`) assert the
  required V2 allocation capabilities and refuse to route against
  V1-only assets. There is no V1 dispatch path to downgrade to.
- Per CIP-0112 §5, V1 assets are expected to publish V2 interfaces
  alongside V1; once an asset advertises V2 in `supportedApis`, the
  library integrates with it.
- The deferred `HoldingEscrow` / `LocalAssetEscrow` modules are the
  physical-custody V1-compatibility path; verify they are not bound into
  the shipped DAR and that the V2 lock-in-place model is the active one.
- Confirm `scripts/check-v2-conformance.sh` blocks forbidden V1 choice
  names (e.g. `Allocation_ExecuteTransfer`) repo-wide.

The seven AllocationRequest trust boundaries and the additional trust
boundaries (asset-registry integrity, CIP-103 dApp provider, proxy
production-hardening) enumerated in
[docs/THREAT-MODEL.md](THREAT-MODEL.md) are part of this scope.

---

## Out Of Scope

- **Off-ledger infrastructure hardening** beyond the ledger interaction
  itself — vault-backed secret storage, network rate limiting, CSRF,
  durable audit logging, and TLS termination topology. These are
  deployment concerns documented in the production-hardening sections of
  [docs/THREAT-MODEL.md](THREAT-MODEL.md) and
  [docs/DEPLOYMENT.md](DEPLOYMENT.md); the reference proxy is explicitly
  dev-grade.
- **Third-party wallet internals** — CIP-103 wallet implementations,
  their key custody, and their signing UX. The dApp never sees private
  keys; wallet correctness is the wallet vendor's responsibility.
- **Upstream Splice / CIP-56 Token Standard package internals** — the
  `splice-api-token-*` DARs are pinned upstream releases and reviewed by
  their own maintainers; this review covers how Canton Payment Streams
  *uses* them, not their implementation.
- **Daml runtime / Canton synchronizer correctness** — ledger-level
  authorization, sequencing, and record-time bounding are assumed
  correct.

---

## Reviewer Checklist

### Build

```bash
pnpm install
pnpm daml:deps        # fetch/build the CIP-56 V2 Token Standard DARs
pnpm daml:build       # or: dpm build --all
```

`daml:build` builds the workspace Daml packages (interfaces, main,
test, scripts). The `canton-streams` DAR depends on the pinned
`splice-api-token-*` V2 packages fetched by `pnpm daml:deps`.

### Run tests

```bash
pnpm daml:test        # runs dpm test in packages/daml/test and packages/daml/scripts
```

### Test suites that exist

Daml-script test suites under
[`packages/daml/test/daml/`](../packages/daml/test/daml/):

| Suite | File |
|---|---|
| Linear vesting | `Test/Stream/Linear.daml` |
| Cliff vesting | `Test/Stream/Cliff.daml` |
| Stepped vesting | `Test/Stream/Stepped.daml` |
| Renewable term | `Test/Stream/Renewable.daml` |
| StreamAdmin lifecycle | `Test/Stream/StreamAdminLifecycle.daml` |
| StreamFlowAdmin lifecycle | `Test/Stream/StreamFlowAdminLifecycle.daml` |
| MilestoneAdmin lifecycle | `Test/Stream/MilestoneAdminLifecycle.daml` |
| V2 AllocationRequest workflow | `Test/Stream/AllocationWorkflow.daml` |
| V2 wallet-only acceptance | `Test/Stream/V2WalletOnly.daml` |
| Invariants | `Test/Invariants.daml` |
| Batch create | `Test/BatchCreate.daml` |
| Settlement | `Test/Settlement.daml` |
| Stream-id uniqueness | `Test/StreamId.daml` |
| DelegatedPolicy enforcement | `Test/Policy/DelegatedPolicyEnforcement.daml` |

### Acceptance

The review is accepted when:

- The Daml packages build cleanly (`pnpm daml:build`).
- The Daml-script suites pass (`pnpm daml:test`).
- The V2 conformance lint passes (`bash scripts/check-v2-conformance.sh`).
- **All Critical and High findings are remediated.** Medium/Low
  findings are accepted with documented rationale or tracked follow-ups.
- The findings are recorded in
  [docs/SECURITY-FINDINGS.md](SECURITY-FINDINGS.md).

---

## Findings Register

The record of the internal review already performed and remediated lives
at [docs/SECURITY-FINDINGS.md](SECURITY-FINDINGS.md). That register is
the authoritative list of findings, their severity, and their
remediation status. The independent reviewer should read it as input,
confirm the remediations on the current source, and append any new
findings.

---

## Engagement Note

To restate plainly: this document is the **preparation for an external
review**, written so an independent reviewer can pick up the codebase
and work efficiently. Commissioning the review — selecting and
contracting an independent reviewer and running the engagement — is a
procurement step the maintainers own. It has not happened yet, and
nothing in this repository should be read as the result of a completed
external audit.
