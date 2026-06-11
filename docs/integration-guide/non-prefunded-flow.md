# Non-prefunded flows (`StreamFlow`)

Reference for the **non-prefunded / rolling top-up** stream — the
`StreamFlow` template. Brings this path to the same depth as the
prefunded `StreamAdmin` / `StreamEscrow` flow documented in
[`streams-integration.md`](./streams-integration.md), the repo
[`WALKTHROUGHS.md`](../WALKTHROUGHS.md), and
[`INTEGRATION-EXAMPLE.md`](../INTEGRATION-EXAMPLE.md).

Source of truth for everything below:

- Daml: `packages/daml/main/daml/CantonStreams/Stream/StreamFlow.daml`
- SDK: `packages/sdk/src/commands/flow.ts` (+ client methods in
  `packages/sdk/src/client.ts`), tests in
  `packages/sdk/test/commands/flow.test.ts`
- Proxy: `packages/proxy/src/index.ts` (`/api/flows` routes)
- Dashboard: `packages/dashboard/src/pages/FlowsPage.tsx`,
  `packages/dashboard/src/hooks/useFlows.ts`
- Probe: `scripts/devnet-streamflow-probe.mjs`

---

## 1. Prefunded vs non-prefunded — when to choose which

| | Prefunded (`StreamAdmin` / `StreamEscrow`) | Non-prefunded (`StreamFlow`) |
|---|---|---|
| Term | Bounded — fixed `startTime` → `endTime` | Open-ended — no end time |
| Commitment | Full total deposited / committed up front | Sender keeps a funded balance, tops up over time |
| Rate | Total amount spread over the term | `flowRate` = tokens per microsecond |
| Funding | Committed allocation locked at accept | Rolling `TopUp_Flow`; recipient draws against funded balance only |
| Credit | n/a (already committed) | **No unsecured credit** — withdrawals strictly bounded by funded balance |
| Settlement | V2 committed-iterated allocation | V2 **iterated** allocation (`nextIterationFunding`) |
| Good for | Vesting, fixed-term payroll, milestone tranches | Subscriptions, recurring infra billing, retainers, long-lived incentive programs, metered / usage-shaped relationships |

The defining property of `StreamFlow` is the **funded boundary**.
Conceptually the recipient is owed `flowRate × elapsed` at any moment
(where `elapsed` excludes paused time), but the actually-withdrawable
amount is:

```
withdrawable(now) = min(accrued(now), fundedAmount) − totalWithdrawn
```

When `accrued > fundedAmount`, the gap is the sender's **debt** — it is
not borrowable on-ledger. The sender clears it by calling `TopUp_Flow`.
The library never extends credit; withdrawals stop at the funded
boundary. (See `flowWithdrawable` / `flowDebt` in `StreamFlow.daml`.)

**Choose prefunded** when the total is known and committed at creation
and the term is bounded. **Choose non-prefunded** when the relationship
is open-ended, the per-period amount may vary, and the sender wants to
fund incrementally rather than lock the whole notional up front.

---

## 2. Lifecycle

```
        create (sender + recipient + escrowOperator sign)
                 │
                 ▼
          ┌──────────────┐   TopUp_Flow (sender + operator)
          │ FlowActive   │◀──────── adds to fundedAmount
          │              │
          │  accruing    │───────▶ Withdraw_Flow (recipient + operator)
          └──────────────┘         recipient claims, bounded by fundedAmount
            │        ▲              numIterations += 1
   Pause_Flow │      │ Resume_Flow
   (sender)   ▼      │ (sender)
          ┌──────────────┐
          │ FlowPaused   │  accrual clock frozen; cumulativePausedDuration grows
          └──────────────┘
                 │
                 ▼  Stop_Flow (sender + recipient + operator)
          ┌──────────────┐
          │ FlowStopped  │  recipient settled, sender refunded, terminal
          └──────────────┘
```

`StreamFlow` has three signatories — `sender`, `recipient`,
`escrowOperator` — so the **create** carries all three in `actAs`. Each
lifecycle choice is `nonconsuming`: it archives and re-creates the
contract, returning a fresh `ContractId StreamFlow`.

### Step → choice → builder → route → dashboard map

| Step | Daml choice | Controllers | SDK builder / client method | Proxy route | Dashboard action |
|---|---|---|---|---|---|
| Create | `create StreamFlow` | sender + recipient + escrowOperator | `buildFlowCreate` / `createFlow` | `POST /api/flows` | **Start a flow** form on the Flows page |
| Top up | `TopUp_Flow` | sender + escrowOperator | `buildTopUpFlow` / `topUpFlow` | `POST /api/flows/:sender/:flowId/top-up` | **Top up** button → modal |
| Withdraw | `Withdraw_Flow` | recipient + escrowOperator | `buildWithdrawFlow` / `withdrawFlow` | `POST /api/flows/:sender/:flowId/withdraw` | **Withdraw** button → modal |
| Pause | `Pause_Flow` | sender | `buildPauseFlow` / `pauseFlow` | — (SDK/client only) | — |
| Resume | `Resume_Flow` | sender | `buildResumeFlow` / `resumeFlow` | — (SDK/client only) | — |
| Stop | `Stop_Flow` | sender + recipient + escrowOperator | `buildStopFlow` / `stopFlow` | `POST /api/flows/:sender/:flowId/stop` | **Stop** button → modal |
| List | (ACS query) | — | `listFlows` | `GET /api/flows` | flow table (auto-loads) |
| View | `GetFlowInfo` | viewer | (decoded into `FlowInfo` by `listFlows`) | — | row columns |

Notes:

- Pause / Resume are exposed through the SDK and the client
  (`pauseFlow` / `resumeFlow`) but have **no proxy route and no
  dashboard button** today — drive them server-side via the SDK.
- `Stop_Flow` asserts that the supplied split is exact:
  `recipientSettlement` must equal the owed-but-unwithdrawn amount at
  `stopTime`, and `senderRefund` must equal the remaining funded
  balance. Compute both from contract state before submitting (the
  probe and the dashboard both do this — see §3 and §5).

---

## 3. Worked SDK example (create → top up → withdraw → stop)

This mirrors `packages/sdk/test/commands/flow.test.ts` and uses the
real builder / client param field names from
`packages/sdk/src/commands/flow.ts`. It compiles against the current
SDK shapes.

```typescript
import { CantonStreamsClient } from '@canton-streams/sdk';
import Decimal from 'decimal.js';

const sender = 'acme::1220aabbccdd';
const recipient = 'bob::1220eeff0011';
const escrowOperator = 'operator::1220a1b2c3d4';

// StreamFlow is signed by all three parties; the client's actAs must
// cover them for the create. (Each later choice needs only its own
// controllers, but a co-hosted client can carry all three.)
const client = new CantonStreamsClient({
  transportMode: 'json-api',
  ledgerApiUrl: 'http://localhost:7575',
  actAs: [sender, recipient, escrowOperator],
});

// 1. Create — flowRate is tokens per MICROSECOND (Numeric 10).
//    e.g. 100 tokens/day = 100 / 86_400_000_000 µs.
const { streamId } = await client.createFlow({
  sender,
  recipient,
  escrowOperator,
  instrumentRef: {
    depository: escrowOperator,
    issuer: escrowOperator,
    instrumentId: 'Amulet',
    instrumentVersion: 'v2',
  },
  flowRate: new Decimal('100').div(86_400_000_000), // 100 tokens/day
  fundedAmount: new Decimal('10'),                  // initial funded balance
  // startTime defaults to now; streamId is generated when omitted.
});

// 2. Top up the funded balance (controller: sender + escrowOperator).
await client.topUpFlow(sender, streamId, {
  topUpAmount: new Decimal('50'),
  settlementReference: `${streamId}:top-up-1`,
});

// 3. Recipient withdraws accrued, bounded by the funded balance
//    (controller: recipient + escrowOperator). withdrawTime defaults
//    to now and must be <= ledger time.
await client.withdrawFlow(sender, streamId, {
  settlementReference: `${streamId}:withdraw-1`,
});

// 4. Mutual stop (controller: sender + recipient + escrowOperator).
//    Stop_Flow asserts the split is exact, so compute both legs from
//    contract state with the same Numeric-10 / HALF_EVEN math the
//    contract uses.
const [flow] = await client.listFlows({ sender, status: 'FlowActive' });
const stopTime = new Date(Date.now() - 1_000);
const elapsedMicros =
  BigInt(stopTime.getTime()) * 1000n -
  BigInt(flow.startTime.getTime()) * 1000n -
  BigInt(Math.trunc(flow.cumulativePausedMicros));
const accrued = flow.flowRate
  .times(elapsedMicros.toString())
  .toDecimalPlaces(10, Decimal.ROUND_HALF_EVEN);
const owed = Decimal.max(
  0,
  Decimal.min(accrued, flow.fundedAmount).minus(flow.totalWithdrawn),
);
const refund = Decimal.max(
  0,
  flow.fundedAmount.minus(flow.totalWithdrawn).minus(owed),
);

await client.stopFlow(sender, streamId, {
  recipientSettlement: owed.toFixed(10),
  senderRefund: refund.toFixed(10),
  recipientSettlementReference: `${streamId}:final-settle`,
  senderRefundReference: `${streamId}:refund`,
});
```

Pause / resume (no proxy route — SDK / client only):

```typescript
await client.pauseFlow(sender, streamId, {});  // pauseTime defaults to now
await client.resumeFlow(sender, streamId, {}); // resumeTime defaults to now
```

Param field names match the builders exactly:

- `CreateFlowParams`: `streamId?`, `sender`, `recipient`,
  `escrowOperator`, `instrumentRef`, `flowRate`, `fundedAmount`,
  `startTime?`, `observers?`
- `TopUpFlowParams`: `topUpAmount`, `settlementReference`
- `WithdrawFlowParams`: `settlementReference`, `withdrawTime?`
- `PauseFlowParams`: `pauseTime?` · `ResumeFlowParams`: `resumeTime?`
- `StopFlowParams`: `recipientSettlement`, `senderRefund`,
  `recipientSettlementReference?`, `senderRefundReference?`, `stopTime?`

---

## 4. Running the probe

`scripts/devnet-streamflow-probe.mjs` exercises one full non-prefunded
cycle against a live participant over the Canton 3.x JSON Ledger API
**v2** (`/v2/...`).

```bash
CANTON_JSON_API_URL=http://<participant>:7575 \
SENDER_PARTY=acme::1220... \
RECIPIENT_PARTY=bob::1220... \
ESCROW_OPERATOR_PARTY=operator::1220... \
INSTRUMENT_ADMIN_PARTY=operator::1220... \
INSTRUMENT_ID=Amulet \
node scripts/devnet-streamflow-probe.mjs
```

What each step does:

1. **Create** a `StreamFlow` with the initial funded balance
   (`INITIAL_FUNDING`), accruing from 1s ago.
2. **`TopUp_Flow`** (sender + operator); asserts `fundedAmount` grew by
   `TOP_UP_AMOUNT`.
3. Wait `ACCRUAL_WAIT_SECONDS`, then **`Withdraw_Flow`** (recipient +
   operator); asserts `totalWithdrawn > 0` and `numIterations == 1`.
4. **`Stop_Flow`** (all three) with the exact settlement split the
   contract recomputes at `stopTime` (Numeric 10, HALF_EVEN).
5. Assert final ACS state: `status == FlowStopped`,
   `totalWithdrawn == fundedAmount`, `pausedAt` empty.

Environment variables (from the probe's `config` block):

| Var | Default | Meaning |
|---|---|---|
| `CANTON_JSON_API_URL` | `http://localhost:7575` | Participant JSON Ledger API v2 base URL |
| `SENDER_PARTY` | — (required) | Stream sender |
| `RECIPIENT_PARTY` | — (required) | Stream recipient |
| `ESCROW_OPERATOR_PARTY` | — (required) | Escrow operator |
| `INSTRUMENT_ADMIN_PARTY` | falls back to `ESCROW_OPERATOR_PARTY` | Instrument admin / issuer (required) |
| `INSTRUMENT_ID` | `Amulet` | Asset instrument id |
| `INSTRUMENT_VERSION` | `v2` | Instrument version |
| `CANTON_LEDGER_TOKEN` | — | Bearer token (omit when auth is off, e.g. LocalNet) |
| `CANTON_USER_ID` | — | Ledger user id (set when the token carries no user claim) |
| `CANTON_STREAMS_PACKAGE_REF` | `#canton-streams` | Package reference for the template id |
| `RATE_PER_SECOND` | `0.01` | Tokens/second; divided by 1e6 to get `flowRate` |
| `FLOW_RATE` | — | Tokens/µs override (bypasses `RATE_PER_SECOND`) |
| `INITIAL_FUNDING` | `1.0` | Initial funded balance at create |
| `TOP_UP_AMOUNT` | `5.0` | Amount added in step 2 |
| `ACCRUAL_WAIT_SECONDS` | `5` | Seconds to wait for accrual before withdraw |
| `STREAM_ID` | `flow-probe-<timestamp>` | Stream id |
| `DRY_RUN` | `false` | When `true`, prints the plan and exits without submitting |

`DRY_RUN=true node scripts/devnet-streamflow-probe.mjs` prints the
5-step plan and the resolved configuration without touching the ledger
— useful for confirming party / instrument wiring before a real run.

**A reachable participant is required.** The probe submits with all
three parties in `actAs` (co-hosted probe topology), so the
`canton-streams` DAR must be uploaded and vetted and sender / recipient
/ escrow operator must be hosted on the target participant. **No public
live `StreamFlow` end-to-end run has been recorded yet** — the live E2E
path needs a participant you can reach. (The prefunded path's live
TestNet/MainNet runs are documented separately in
`streams-integration.md`; those do not cover `StreamFlow`.)

---

## 5. Dashboard path

The reference dashboard (`packages/dashboard/`) exposes the flow
lifecycle on a dedicated page.

1. Connect to a Canton participant (the page shows "Connect to a Canton
   participant to view flows" until a party is connected).
2. In the left sidebar, open **Flows** (route `/flows`).
3. **Start a flow** — fill in recipient party, escrow operator party,
   instrument admin, instrument id, **Rate (tokens / day)**, and
   optional initial funding, then **Create flow**. The page converts
   tokens/day to the on-ledger `flowRate` (tokens/µs at Numeric 10) on
   submit.
4. The **Your flows** table lists flows you send and receive (the page
   runs both a `sender` and a `recipient` query and de-dupes). Per row:
   - **Top up** (visible to the sender) → modal: amount + settlement
     reference.
   - **Withdraw** (visible to the recipient) → modal: settlement
     reference; claims everything accrued so far, bounded by the funded
     balance.
   - **Stop** (visible to either party) → modal: shows the computed
     **recipient settlement** and **sender refund**, plus an optional
     settlement reference. The modal computes the exact split client-side
     (Numeric 10, HALF_EVEN) so the `Stop_Flow` assertion passes.

Pause / resume are not surfaced in the dashboard; use the SDK for those.

> **Maturity note — operator/co-hosted reference, not yet hosted-wallet.**
> The current `StreamFlow` path is a solid **operator / co-hosted
> reference**: the proxy creates and drives flows by submitting with
> `sender` + `recipient` + `escrowOperator` together in `actAs`
> (`packages/proxy/src/index.ts`, `POST /api/flows` — see the
> `createClientForAuthWithParties(auth, [recipient, escrowOperator])`
> call), and the SDK/probe path co-hosts all three parties on one
> participant. A **fully hosted-wallet `StreamFlow` UX is future work**:
> the dashboard's hosted-wallet client does not yet wire StreamFlow —
> `createFlow` / `topUpFlow` / `withdrawFlow` / `stopFlow` throw
> `HostedWalletWriteUnsupportedError`, and `listFlows` returns an empty
> result because there is no browser-side StreamFlow decoder yet
> (`packages/dashboard/src/api/client.ts`). Use the SDK/proxy path for
> StreamFlow today; treat hosted-wallet StreamFlow as not yet wired.

---

## 6. Settlement semantics (V2 iterated allocation)

`StreamFlow` uses **V2 iterated allocation** exclusively. A single
`AllocationV2.Allocation` is created when the stream starts, and
`Allocation_Settle.nextIterationFunding` tops it up for each subsequent
accrual period:

- **`numIterations`** is the cycle counter. Each `Withdraw_Flow`
  increments it and corresponds to one `Allocation_Settle` exercise on
  the underlying V2 Allocation. The proxy's `TransferEventsV2`
  subscriber reacts to settle events and advances contract state.
- **`TopUp_Flow` adjusts `nextIterationFunding`.** In V2 terms, a
  top-up is the next iteration's funding being adjusted upward — the
  executor exercises `Allocation_Settle.nextIterationFunding` with the
  additional amount. On the `StreamFlow` contract this just raises
  `fundedAmount`.
- `StreamFlow` implements the CIP-0112 V2 `AllocationRequest` interface
  so V2-aware wallets recognize it as a recurring request. The view
  carries iterated-allocation hints (`numIterations`, `iterated: true`,
  `flowRate`) and exposes `pause` / `resume` / `topUp` as custom
  allocation actions.
- **V1 is not supported.** Per CIP-0112, V2 committed-iterated
  allocations are the primitive for prefunded / streaming flows; V1 had
  no iterated equivalent.

See `WALKTHROUGHS.md` (Walkthrough 2 — rolling subscription) for the
settle / `nextIterationFunding` view of the same lifecycle.
