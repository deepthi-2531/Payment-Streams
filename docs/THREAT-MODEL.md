# Threat Model

Security analysis and invariant verification for Canton Payment Streams.

---

## Trust Model

### Parties

| Party             | Role                                                       |
|-------------------|------------------------------------------------------------|
| **Sender**        | Funds the stream. Signatory on the stream-admin template (`StreamAdmin`/`StreamFlow`/`MilestoneAdmin`). Can authorise allocations against held funds. |
| **Recipient**     | Receives streamed tokens. Observer on the stream-admin template; consent/custody rights are enforced through the V2 `AllocationRequest` / `Allocation` contracts. |
| **Escrow Operator** | Service party that drives V2 allocation settlement. Observer/controller on the stream-admin template; exercises `Allocation_Settle` / `SettlementFactory_SettleBatch` on the V2 `Allocation` contracts. |
| **Observers**     | Parties with read-only visibility. Can call `GetStreamInfo` but cannot modify state. |

### Signatory model

The stream-admin templates (`StreamAdmin`, `StreamFlowAdmin`,
`MilestoneAdmin`) are sender-signed metadata/observability contracts.
Recipient consent and custody authorization are enforced by the V2
`AllocationRequest` / `Allocation` lifecycle. This means:

- Stream funding requires recipient consent — the wallet flow lands
  an `AllocationRequest` that the recipient's wallet accepts via
  `AllocationFactory_Allocate(committed=True)`, atomically locking
  the sender's funding.
- A sender can create metadata for a proposed stream, but cannot move
  funds or bind the recipient without the V2 allocation acceptance path.
- The Daml runtime enforces that only authorised controllers can
  exercise choices on both the stream-admin template and the
  underlying V2 `Allocation`.

---

## Attack Surface Analysis

### 1. Unauthorized withdrawal

**Threat:** A party other than the recipient withdraws funds.

**Mitigation:** The `Withdraw_Stream` choice is controlled by
`config.recipient`. The Daml runtime rejects exercise attempts from
any other party. The authorization check is enforced at the ledger
level, not in application code.

```
controller config.recipient
```

**Residual risk:** None. This is a Daml language-level guarantee.

### 2. Unauthorized cancellation

**Threat:** A party other than the sender cancels the stream, or the
sender cancels a non-cancellable stream.

**Mitigation:**
- `Cancel_Stream` is controlled by `config.sender` and guarded by
  `assertMsg "Stream not cancellable" config.cancellable`.
- `MutualCancel_Stream` requires both sender and recipient as
  controllers (joint authorization).
- The `cancellable` flag is immutable after creation (part of
  `StreamConfig`).

**Residual risk:** None for unilateral cancellation. Mutual
cancellation requires explicit agreement from both parties.

### 3. Double withdrawal

**Threat:** The recipient exploits a race condition to withdraw the
same funds twice.

**Mitigation:** The `Withdraw_Stream` choice uses a
nonconsuming-then-archive-then-create pattern:

1. The choice is marked `nonconsuming` at the Daml level.
2. Inside the choice body, `archive self` consumes the current contract.
3. A new contract is created with updated `totalWithdrawn`.

Canton's sequencing guarantees that two concurrent exercises of the
same contract ID will be serialized. The first succeeds; the second
fails with `CONTRACT_NOT_ACTIVE` because the original contract was
archived.

**Residual risk:** None. Canton's transaction ordering prevents
double-spend.

### 4. Balance inflation

**Threat:** Rounding errors cause more tokens to be withdrawable than
were deposited.

**Mitigation:**
- All accrual functions use truncate-toward-zero rounding (Daml
  `Decimal` division truncates).
- The `withdrawable` function: `max 0.0 (accrued - totalWithdrawn)`.
- The `refundable` function: `max 0.0 (totalDeposited - accrued)`.
- The `ensure` block on `StreamEscrow` enforces:
  ```
  state.totalWithdrawn >= 0.0
  state.totalWithdrawn <= config.totalDeposited
  escrow.amount >= 0.0
  ```
- The `checkInvariant` function verifies before every settlement:
  ```
  refundable + withdrawable + totalWithdrawn <= totalDeposited
  ```

Dust (the tiny remainder from truncation) always stays with the sender,
never the recipient.

**Residual risk:** Dust accumulation up to 1 minimum Decimal unit per
withdrawal. This is by design and always favors the sender.

### 5. Time manipulation

**Threat:** A malicious party submits a transaction with a fabricated
future timestamp to unlock tokens early.

**Mitigation:** Two distinct layers, and the distinction matters:

1. **The transaction's ledger effective time** is bounded by Canton —
   a submission's record time must fall within the participant's time
   tolerance window (typically a few seconds), so it cannot be
   significantly in the future.

2. **The `withdrawTime` / `cancelTime` / `completeTime` / `renewTime` /
   `pauseTime` / `resumeTime` choice arguments are ordinary data.**
   Canton does NOT validate a `Time` *field* against ledger time — it
   only bounds the transaction's record time. Each fund-moving choice
   must therefore assert the bound itself:

   ```daml
   now <- getTime
   assertMsg "withdrawTime must be at or before ledger time" (withdrawTime <= now)
   ```

   This guard is present on every withdraw, cancel, mutual-cancel,
   complete, renew, pause, and resume choice in `Escrow.daml`,
   `HoldingEscrow.daml`, `LocalAssetEscrow.daml`, and `StreamFlow.daml`.
   Without it (CR-1/CR-2 in the v0.2.7 audit) a recipient could pass
   `withdrawTime = endTime` to drain the escrow day one, or a sender
   could pass `cancelTime = startTime` to clawback already-vested funds.

**Residual risk:** Minimal. `getTime` returns the transaction's ledger
time, which Canton bounds to the tolerance window (seconds) — negligible
relative to stream durations (days to months). An earlier-than-now value
is permitted but never benefits the submitter: under-stating the time can
only *reduce* what a withdrawer or canceller can extract.

### 6. Front-running

**Threat:** An adversary observes a pending withdrawal and submits a
competing transaction first.

**Mitigation:** Not applicable. Canton does not have a public mempool.
Transactions are submitted privately to the participant node and
sequenced by the synchronizer (domain). There is no visibility into
pending transactions from other parties.

**Residual risk:** None for the front-running vector. Concurrent
withdrawals by the same party are handled by the archive-create
pattern (see double withdrawal above).

### 7. Observer escalation

**Threat:** An observer party attempts to withdraw, cancel, or modify
a stream.

**Mitigation:** Observers are listed in the `observer` clause of the
template. The Daml runtime grants observers read access only. All
mutating choices have explicit `controller` declarations (sender or
recipient). The `GetStreamInfo` choice additionally checks:

```
viewer == config.sender || viewer == config.recipient || viewer `elem` observers
```

**Residual risk:** None. Observer-to-controller escalation is
prevented by the Daml type system.

---

## Core Invariants

These invariants are enforced by the Daml templates and verified in
the `checkInvariant` function (`CantonStreams.Stream.Accrual`).

### Invariant 1: Withdrawal bound

```
0 <= totalWithdrawn <= accrued(now) <= totalDeposited
```

- `totalWithdrawn` starts at 0 and only increases.
- `accrued(now)` is capped at `totalDeposited` by all accrual functions.
- Withdrawal amount is `accrued - totalWithdrawn`, guaranteed non-negative.

### Invariant 2: Conservation (with dust tolerance)

```
refundable(now) + withdrawable(now) + alreadyWithdrawn = totalDeposited
```

More precisely (accounting for truncation dust):

```
refundable(now) + withdrawable(now) + totalWithdrawn + dust = totalDeposited
where dust >= 0 and dust <= 1 minimum Decimal unit
```

This ensures no tokens are created or destroyed.

### Invariant 3: Monotonic accrual

```
For t1 <= t2: accrued(t1) <= accrued(t2)
```

All vesting modes produce monotonically non-decreasing accrual curves:
- **Linear:** Proportional to elapsed time.
- **CliffLinear:** Zero then linear (step function + linear).
- **Stepped:** Staircase function (non-decreasing).
- **RenewableTerm:** Linear within each term.

### Invariant 4: Terminal state finality

```
status in {Cancelled, Completed} => no further Withdraw/Cancel/Renew
```

- `Withdraw_Stream` asserts `state.status == Active`.
- `Cancel_Stream` asserts `state.status == Active`.
- `Renew_Stream` asserts `state.status in [Active, Completed]` (only
  for renewable terms; completed terms can be renewed to restart).
- Once cancelled, no choice can transition the stream back to active.

### Invariant 5: Template ensure clause

Every `StreamEscrow` contract creation is guarded by:

```
config.totalDeposited > 0.0
  && config.startTime < config.endTime
  && state.totalWithdrawn >= 0.0
  && state.totalWithdrawn <= config.totalDeposited
  && escrow.amount >= 0.0
```

This prevents invalid contracts from ever existing on the ledger.

---

## Settlement Mode Security

As of 0.2.8, the only supported settlement mode is `TokenStandardCustody`
(CIP-56 V2 Token Standard via CIP-0112 `AllocationRequest`). The legacy
`NumericLegacy`, `UtilityHoldingCustody`, `LocalAssetCustody`, and
`Delegated` modes from earlier releases have been removed; their threat
analyses are kept in version-control history under the `0.2.7` tag for
reference.

### TokenStandardCustody (the only mode)

- **Mechanism:** The dApp constructs a V2 `AllocationRequest`; the
  recipient accepts via `AllocationFactory_Allocate(committed=True)`,
  which **atomically** locks the sender's funding against the escrow
  operator. Per accrual interval, `Allocation_Settle` moves
  funds from lock to recipient.
- **Trust assumption:** Daml authority — the `Allocation` template's
  signatory set includes the sender, the recipient, and the asset
  admin. No off-ledger trust is required for the settlement itself.
- **Custody path:** The sender's tokens are locked in place (or, for
  V1-compatibility paths, physically moved to an escrow operator's
  holding). Either way, the escrow operator cannot steal funds —
  every settlement choice is controller-gated and bounded by the
  on-ledger spec.
- **Capability negotiation:** The library reads
  `getAssetCapabilities(instrumentRef)` and selects the V1 or V2
  adapter per CIP-0112 §5 automatically. dApps don't branch by asset.
- **Risk surface:**
  - Escrow operator can delay settlement if unresponsive (but cannot
    misappropriate). Mitigation: monitor `TransferEventsV2` lag.
  - Wallet gateway compromise of the sender's signing material would
    let an attacker drain funds at create time. Mitigation: standard
    wallet hygiene; for institutional flows use HSM-backed signing.
  - V1↔V2 mixed-asset settlement requires both interfaces to agree on
    leg amounts. Mitigation: the `AllocationBridge` view-builder
    helpers enforce conservation invariants.
- **DelegatedPolicy (bounded trust-minimized executor):** for streams
  where the recipient wants to delegate the withdraw action to a
  service without trusting it fully, `DelegatedPolicy` provides
  on-ledger bounded authority (rate limit, expiry, scope,
  action allow-list, cooldown). Every *successful* execution is
  recorded in an append-only `ExecutionLog`. Note: a failed
  execution aborts the whole transaction (Daml has no partial
  commit), so the failure is NOT written to the on-ledger log —
  it surfaces only in the executor's off-ledger logs. The
  `ExecutionLog.success` field is therefore always `True`; treat
  the absence of an expected log entry, not a `success=False`
  entry, as the signal that an execution failed. Revocable at any
  time by the delegator.

---

## Auth Layer Security

### JWT verification

- **Production:** The proxy verifies JWTs against a JWKS endpoint
  (`AUTH_JWKS_URL`). Tokens must contain the acting party claim.
- **Development:** `AUTH_MODE=dev` disables JWT verification for local
  testing. Never use dev mode in production.
- **Token-to-party binding:** The proxy reads the acting party from
  the JWT `party` (or `sub`) claim. The legacy `X-Canton-Party` header
  is still accepted for backwards compatibility but the JWT claim is
  authoritative — a token for Alice cannot be used to act as Bob.

### Service tokens

- Certain operations (e.g., `POST /api/streams/:id/finalize`) require
  a service-level token that identifies the escrow operator.
- Service tokens are validated separately and reject user-level tokens.

### Dev vs production modes

| Setting         | Dev Mode                  | Production              |
|-----------------|---------------------------|-------------------------|
| JWT validation  | Disabled                  | JWKS-verified           |
| Party binding   | JWT `party`/`sub` claim (unsigned)  | Verified from JWT claim |
| CORS            | `*`                       | Configured allow-list   |
| TLS             | Optional                  | Required                |

---

## Proxy Security

### CORS

The proxy should be configured with a strict CORS allow-list in
production:

```
CORS_ORIGIN=https://dashboard.example.com
```

Do not use `*` in production.

### Rate limiting

The proxy does not implement rate limiting by default. For production
deployments:

- Deploy behind a reverse proxy (nginx, Envoy) with rate limiting.
- Consider per-party rate limits to prevent a single party from
  monopolizing the Ledger API.
- Suggested limits: 100 requests/minute per party for write operations,
  1000 requests/minute for reads.

### Service token for operator actions

Custody finalization endpoints require service-level authentication.
The service token should:

- Be rotated regularly (e.g., every 24 hours).
- Have a short TTL.
- Be stored in a secrets manager, not in environment variables.

---

## Recommendations for Production Deployment

1. **Enable TLS** on all connections (proxy-to-Canton, client-to-proxy).
2. **Use `TokenStandardCustody`** for all real-asset settlement — it is
   the only supported settlement mode as of 0.2.8.
3. **Configure JWKS** with a production identity provider. Disable dev mode.
4. **Deploy the proxy behind a load balancer** with TLS termination and
   rate limiting.
5. **Monitor invariant violations.** Any `checkInvariant` failure logged
   on-ledger should trigger a P1 alert.
6. **Restrict observer access.** Only add observers who genuinely need
   visibility into stream terms.
7. **Set Canton time tolerance** appropriately. The default (a few
   seconds) is sufficient for most deployments.
8. **Audit executor policies**. Regularly review active
   `DelegatedPolicy` contracts and execution logs.
9. **Back up participant state** before DAR upgrades.
10. **Run Daml script invariant tests** as part of CI/CD before deploying
    DAR updates.

---

## Additional Trust Boundaries

This section covers the trust boundaries introduced by the V2-only CIP-56
allocation path, V2 runtime capability gating per CIP-0112, on-ledger
DelegatedPolicy enforcement, multi-Scan adoption verification, and the
CIP-103 dApp Provider.

### V2-Only CIP-56 Settlement Path

The library ships **one** V2 allocation path for assets that advertise
the required V2 allocation capabilities. Per-asset differences (admin
party, Scan endpoint, wallet-gateway URL, capability flags) live in
`config/asset-registry.json`; the SDK never branches by asset name.

**Threats**

| Threat | Surface | Mitigation |
|---|---|---|
| Asset registry tampering | `config/asset-registry.json` is committed in-repo; a malicious edit could route to an attacker-controlled Scan or wallet-gateway | Registry file is reviewed in code review and pinned per release. Adoption-metrics tooling consumes the manifest from a known repo + commit, not from mutable runtime config |
| Asset advertises V2 but doesn't honor V2 semantics | All routing goes through V2 — no fallback | `getAssetCapabilities` can be refreshed against on-chain metadata. If V2 errors surface, library fails-fast with the asset key + error context; operator decides whether to retry. **V1 fallback path does not exist**. |
| InstrumentRef spoofing | A malicious actor could craft an `InstrumentRef` for a different asset | V2 capability resolution binds the asset to its registry admin and instrument id; stream creation must use a registered V2 asset entry |
| Settlement reference forgery | A malicious actor could spoof stream metadata | V2 `SettlementInfo` and `AllocationSpecification` are signed ledger arguments; the adoption-metrics aggregator verifies by querying public Scan, not by trusting in-repo data |

### CIP-0112 V2 capability assertion

The capabilities layer (`packages/sdk/src/assets/capabilities.ts`)
asserts V2 capabilities at dispatch time and refuses to route against
V1-only assets. Per CIP-0112 §5, V1 assets are expected to publish V2
interfaces alongside V1; once they do, this library integrates against
them. V1-only assets are not supported — the streaming primitive requires
the V2 committed + iterated allocation primitive that V1 lacks.

**Threats**

- **~~Downgrade attack~~** *(no longer applicable — V1 path removed)*: the
  downgrade-to-V1 attack vector is closed because the V1 dispatch path
  does not exist in the library. There is nothing to downgrade to.
- **Upgrade attack**: an attacker influences resolution to pick V2 when
  the asset doesn't actually support V2.
  **Mitigation**: V2-only operations (multi-leg allocations, batch
  settlement, TransferEventsV2) fail at the ledger level; `selectAdapter`
  throws a descriptive error before submission for incompatible
  combinations.

### Lock-in-place V2 Custody vs Physical V1 Custody

V1 (`TokenStandardEscrow`) and the deprecated `UtilityHoldingEscrow`
both **physically move holdings** into the escrow operator's custody.
V2 introduces `Holding.Lock { holders, expiresAt/expiresAfter, context }`
which allows **lock-in-place** custody: the holding stays in the
sender's account but is locked to the recipient + escrow operator as
joint holders.

**Comparison**

| Aspect | V1 physical custody | V2 lock-in-place |
|---|---|---|
| Holding ownership | Escrow operator | Sender (unchanged) |
| Lock expiry | None (custody-based) | First-class (`expiresAt` / `expiresAfter`) |
| Operational complexity | Higher (split/merge of holdings) | Lower (lock + unlock) |
| Failure mode | Holding stuck in operator custody if operator party becomes unreachable | Lock expires; sender recovers ability to move |
| Audit context | Operator's holding history | Lock context string is auditable on-ledger |

**Recommendation**: V2 lock-in-place is the preferred model for new
deployments once V2 capability is advertised. V1 physical custody
remains the only option for V1-only assets.

### DelegatedPolicy On-Ledger Enforcement

`CantonStreams.Policy.DelegatedPolicy` is the bounded executor
delegation contract. Signed by sender + recipient + executor. Enforces
on-ledger: `active` flag, `expiresAt`, `allowedActions`, `streamFilters`
(scope), `rateLimit.maxAmountPerExecution`, `rateLimit.cooldownInterval`,
`rateLimit.maxExecutionsPerPeriod`.

**Threats**

| Threat | Mitigation |
|---|---|
| Executor exceeds delegated bounds | All bounds enforced in `ExecutePolicy` choice on-ledger; no client-side trust |
| Stale rate-limit state | `PolicyExecutionState` archive-and-recreate pattern atomically updates accounting on each execution |
| Replay of revoked policies | `active = False` check rejects all subsequent `ExecutePolicy` |
| Period rate-limit bypass via clock skew | Period evaluation uses ledger time, not wall-clock |
| ExecutionLog tampering | Append-only template with only `PruneExecutionLog` (sender-controlled) as mutator |

### Multi-Scan Endpoint Adoption Verification

The adoption-metrics tooling (`scripts/query-adoption-metrics.mjs`)
aggregates across multiple SV Scan endpoints, one per asset in the
registry.

**Threats**

| Threat | Mitigation |
|---|---|
| Self-dealing inflating metrics | Exclusion list of affiliate party identifiers; the metrics tool excludes their transactions |
| Forged Scan responses | Operators independently pick the Scan endpoint URLs from canonical network status, not from app runtime |
| Stale registry routing | Registry is versioned and committed; operators pin to a specific commit for reporting |
| Cross-asset aggregation errors | Each Scan endpoint queried separately with the same template-id filter; results joined post-query, no shared trust |

### CIP-103 dApp Provider Trust Boundary

The CIP-103 Provider (in `packages/dashboard/src/lib/cip103/`) is the
browser-side trust boundary between the dashboard and the user's
wallet. The wallet holds private keys; the dApp never sees them.

**Threats**

| Threat | Mitigation |
|---|---|
| Malicious wallet returns spoofed signatures | Wallet signs against canonical OpenRPC schema; ledger validates signature on submission |
| Replay of signed transactions | Daml command ids are unique per submission; participant deduplicates |
| Phishing dApp impersonates Canton Streams to user's wallet | Wallet UX should display the dApp origin; user verifies before approving (out of scope for the library, in scope for wallet implementations) |
| Provider event spoofing (txChanged, accountsChanged) | Library treats provider events as advisory; canonical state always re-queried via `ledgerApi` proxy or wallet-issued direct ledger token |
| EIP-1474 error code injection | `CIP103Error` class enforces typed numeric codes; downstream UI displays the error but doesn't elevate trust based on its content |

### Proxy Production-Hardening Trust Boundary

The reference proxy (`packages/proxy/`) is a **dev-grade** server-side
trust boundary. Production deployments require vault-backed secrets, rate
limits, CSRF protection, persistent audit logs, and correlation IDs before
being exposed to untrusted networks. The current proxy is **not**
appropriate for direct internet exposure.

**Threats not yet mitigated**

- `PROXY_SERVICE_TOKEN` in env-var memory rather than vault
- Permissive CORS; no origin allowlist
- No per-party / per-action rate limiting
- No CSRF on state-changing routes
- Audit trail to stdout only (not append-only durable storage)
- No request correlation IDs propagated browser → proxy → ledger
- Per-role response filtering not implemented
- Graceful shutdown does not drain auto-withdraw worker

### Security Review Scope

Independent security reviews should cover:

1. Core escrow templates (`StreamEscrow`, `TokenStandardEscrow`)
2. `StreamFlow` (rolling top-up) templates
3. Unified propose / accept workflow (`UnifiedStream`)
4. `DelegatedPolicy` + `PolicyExecutionState` + `ExecutionLog` enforcement
5. CIP-56 V2 allocation and settlement orchestration
6. TransferEventsV2 subscriber plus raw Ledger API V2 fallback
7. Off-ledger trust boundary: proxy, executor, auto-withdraw worker
8. SDK V2 capability gating (`getAssetCapabilities`)
9. Asset registry integrity model

---

## AllocationRequest Pattern — Trust Boundaries

The V2-native AllocationRequest migration (plan §7) replaces the
deprecated **settlement-reference path** (off-chain wallet-gateway
prepare/execute calls anchored to on-ledger settlement references)
with the **idiomatic CIP-56 Token Standard pattern**:

1. The stream admin contract (StreamAdmin / StreamFlow / MilestoneAdmin)
   exposes the V2 `AllocationRequest` shape.
2. Senders' wallets observe the request and create `AllocationV2.Allocation`
   contracts reserving the funds.
3. The escrow operator (or any executor authorized by the
   `SettlementInfo.executor` field) exercises `Allocation_Settle` to
   atomically move the funds and emit settlement events.
4. The proxy's `TransferEventsSubscriber` reacts to the settle
   event and exercises the stream-state-advancing choice
   (`Withdraw_Stream` / `Withdraw_Flow` / `ConfirmMilestone`).

This section enumerates the new trust boundaries and invariants
introduced by the AllocationRequest pattern.

### ~~Trust boundary 1: dual-interface implementation~~

V2-only architecture — templates implement only `AllocationRequestV2`.
The dual-interface consistency-attack surface is closed because the V1
interface is not implemented. `AllocationBridge.v1V2ViewsConsistent` and
`liftV1ToV2View` have been deleted from the codebase; `V1V2Mixed.daml`
test deleted.

V1-asset support follows the [CIP-0112 §5](https://github.com/canton-foundation/cips/blob/main/cip-0112/cip-0112.md#5-backwards-compatibility)
path: assets dual-implement V1+V2; once an asset advertises V2, our
library integrates with it. We never see the V1 surface.

### Trust boundary 2: settlement-info deadlines

**Risk:** V2's `SettlementInfo.allocateBefore` and `settleBefore`
deadlines are enforced on-ledger. If the contract's view computes
deadlines from stale state, a settlement could either (a) accept a
late allocation that should have been rejected, or (b) reject a
timely allocation by computing an overly-tight deadline.

**Mitigation:**

- The view's `requestedAt` is set to `config.startTime` (a stable
  contract field). Per-cycle deadlines are refined at exercise time
  by the SDK at settle time; the view value is
  a worst-case upper bound used for advisory display.
- `defaultSettleBuffer = 5 minutes` (Daml `Bridge.defaultSettleBuffer`)
  matches the SDK default. Both sides must agree on the buffer or the
  settlement deadline check can fail.
- V1 is not supported by this implementation.

### Trust boundary 3: AccountV2 provider field (institutional custody)

**Risk:** V2's `AccountV2 { owner, provider : Optional Party, id }`
introduces a custodian-visibility role. A malicious provider party
could observe stream lifecycle events and front-run them, or a
misconfigured provider could deny settlement.

**Mitigation:**

- The default escrow templates (`streamRecipientAccountV2`) construct
  `AccountV2` with `provider = None`. Institutional callers that
  supply a provider opt into this trust boundary explicitly.
- `Holding.Lock { holders }` in V2 includes the recipient AND the
  escrow operator as joint holders, so neither can unilaterally move
  the locked funds without consent from the other side.
- Audit recommendation: any deployment that supplies a non-None
  provider must document the trust relationship between recipient and
  custodian in `docs/validation/`.

### Trust boundary 4: iterated allocation (V2 StreamFlow)

**Risk:** V2's iterated-allocation feature (`Allocation_Settle.nextIterationFunding`)
allows the executor to re-settle the same Allocation contract across
multiple periods. A misbehaving executor could:

- Over-fund the next iteration (drains sender beyond the agreed flow rate)
- Under-fund (recipient gets less than the agreed rate)
- Settle out of order (race the cumulative pause/resume bookkeeping)

**Mitigation:**

- `StreamFlow.Withdraw_Flow` enforces `amount = flowWithdrawable accrued fundedAmount totalWithdrawn`,
  which is bounded by both the accrued amount AND the funded balance.
  No credit is extended on-ledger.
- `numIterations` increments on each `Withdraw_Flow` exercise; the
  subscriber correlates settle events to specific cycles via this
  counter + the `cycle-N` suffix on `settlementRef.id`.
- The cumulative paused duration is recorded in `cumulativePausedDuration`
  and validated against the lock-step `pausedAt` field in the
  contract's `ensure` clause.

### Trust boundary 5: multi-leg batch settlement (V2 MilestoneEscrow)

**Risk:** V2's `SettlementFactory_SettleBatch` atomically settles
multiple Allocations in a single transaction. A malicious executor
could mix legs from different streams or include unauthorized legs.

**Mitigation:**

- Each `Allocation` references its originating `SettlementInfo` (via
  `Allocation_View.settlement`). The batch settlement requires all
  legs to reference the same `SettlementInfo` — different streams
  cannot be co-settled.
- The escrow operator party is the `executor` on the SettlementInfo;
  only that party can drive `SettlementFactory_SettleBatch`.
- Multi-leg view conservation is checked by
  `Bridge.checkConservationV2` — total leg amount cannot exceed the
  remaining undrawn balance (per stream).

### Trust boundary 6: interface package alignment

**Risk:** If the Daml interface packages used by this repository drift
from the V2 interfaces implemented by wallets, deployments will not
interoperate with V2 wallets.

**Mitigation:**

- The Daml dependency fetcher pins upstream package versions in
  `scripts/fetch-v2-dars.mjs`.
- `scripts/check-v2-conformance.sh` blocks forbidden V1 command names.
- Release validation should rebuild the DARs and run the V2 wallet-only
  Daml scenarios against the pinned interface packages.

### Trust boundary 7: subscriber-driven state advancement

**Risk:** The `TransferEventsSubscriber` reacts to `Allocation_Settle`
events from the ledger and exercises stream-advancing choices. A
malicious actor could spoof settlement events (e.g. by exercising
`Allocation_Settle` on a stream they don't legitimately participate
in) and cause the subscriber to advance the wrong stream's state.

**Mitigation:**

- The subscriber's package-hash filter (`packageHashes` in
  `SubscriberConfig`) scopes events to only our published DARs;
  exercises against other packages are ignored.
- The exercise-record's `templateId` must start with one of our
  manifest hashes (`build-template-manifest.mjs` output) — a foreign
  DAR cannot impersonate a CantonStreams template.
- The subscriber's `onSettlement` handler validates that the affected
  Allocation references one of the stream contracts the escrow
  operator party signs; orphan settlements are logged and dropped.
- Reconnect uses exponential backoff to avoid amplifying a malicious
  settlement flood into self-DoS.

### Security Review Checklist

When security teams assess the AllocationRequest pattern, the scope should include:

1. The seven trust boundaries above
2. Daml-script test coverage, including `Test.Stream.AllocationWorkflow`
3. SDK capability negotiation (`getAssetCapabilities`, `selectAdapter`)
4. `dispatchSettlement` routing matrix for supported V2 flows
5. Subscriber package-hash + template-id filtering
6. Asset registry integrity (signatures on the in-repo JSON; CI
   verification that `build-asset-registry.mjs` output matches
   `config/asset-registry.json`)
