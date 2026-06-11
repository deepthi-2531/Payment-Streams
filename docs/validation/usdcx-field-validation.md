# USDCx field validation — transitional V1 lane

> **Status:** USDCx is a CIP-56 V1 token-standard asset live on MainNet today.
> It settles streams through the same transitional V1 lane
> (`splice-api-token-allocation-v1`) that was field-validated with real Canton
> Coin on TestNet on 2026-06-10 (three allocate → execute-transfer cycles plus
> an instrumented balance-conservation run; see
> [first-dapp-integration-testnet.md](../reports/first-dapp-integration-testnet.md)
> and [V1-LANE-TESTING.md](../V1-LANE-TESTING.md)).
>
> **Evidence honesty:** no live USDCx cycle has been executed yet — it is
> blocked on a party funded with USDCx and the issuer's registry endpoint.
> Everything below is split explicitly into *validated today* vs *pending
> live run*. There is no USDCx run data in this document.

## 1. Code-path parity with CC

USDCx and CC share the identical V1 code path end to end. The only thing
that differs is registry routing data — which is the design goal: the SDK
never branches by asset name, only by capability flags.

| Layer | Shared component | Per-asset difference |
| --- | --- | --- |
| Wire builders | `packages/sdk/src/commands/allocation-v1.ts` (SettlementInfo, TransferLeg, ExtraArgs/ChoiceContext) | none — `InstrumentId { admin, id }` values come from the registry |
| Dispatch | `dispatchSettlementV1` + capability gate (`packages/sdk/src/settlement/allocation-dispatch.ts`, `packages/sdk/src/assets/capabilities.ts`) | none |
| Choice contexts | `packages/sdk/src/settlement/choice-context.ts` (`/registry/allocation-instruction/v1/allocation-factory`, `/registry/allocations/v1/{cid}/choice-contexts/execute-transfer`) | base URL: Scan host for Amulet vs the USDCx issuer's registry endpoint |
| Disclosed contracts | gRPC + JSON API transports | none — passed through verbatim from the registry response |
| On-ledger request shim | `packages/daml/v1-shim` (`StreamAllocationRequestV1`) | none |
| Probes | `scripts/devnet-v1-cc-stream-probe.mjs` (one V1 cycle), `scripts/testnet-usdcx-stream-probe.mjs` (lifecycle, `--asset-key`) | registry entry selected by `--asset-key cc` / `--asset-key usdcx` |
| Registry routing | `config/asset-registry.json` | `instrumentIdV2` (doubles as the V1 InstrumentId), `adminParty`, `tokenStandardApiUrl`, Scan/wallet-gateway URLs |

Expected per-asset behavioral differences to watch for on the live run
(all wire-compatible via the V1 interfaces):

- **Factory template.** Scan returns `ExternalPartyAmuletRules` as Amulet's
  `AllocationFactory`; the USDCx registry returns its own implementation.
  The SDK exercises the interface choice, so only the disclosed template ids
  in logs will differ.
- **Allocation template id for polling.** CC polls
  `Splice.AmuletAllocation:AmuletAllocation`; USDCx needs the issuer's
  allocation template id (set `ALLOCATION_TEMPLATE_ID`, or pass
  `ALLOCATION_CID` after allocating in the wallet UI).
- **Fees.** CC showed exact balance conservation (post-CIP-78, no transfer
  fees). USDCx fee behavior must be observed, not assumed — record the
  before/after deltas rather than asserting zero a priori.

## 2. What is validated today

| Item | Evidence |
| --- | --- |
| V1 wire encodings (allocation request, `Allocation_ExecuteTransfer`/`_Cancel`/`_Withdraw`, ExtraArgs/ChoiceContext) | SDK unit tests — 285 tests across 21 files green (`corepack pnpm --filter @canton-streams/sdk test`, 2026-06-11) |
| Shared V1 lane against a real network | Field-proven with CC on TestNet: 3 cycles + instrumented conservation run, publicly verifiable update ids in [first-dapp-integration-testnet.md](../reports/first-dapp-integration-testnet.md) |
| Registry lookup for `usdcx` | `loadAssetRegistry(config/asset-registry.json)` resolves `usdcx`; `resolveSettlementVersion` routes `v1`; `getAssetByV2Id({ admin, id })` round-trips |
| Capability gating | `allocation-iterated` / `allocation-batch` on `usdcx` throw (V2-only actions); recurring streams run one cycle per withdrawal |
| Probe flag parsing + registry override | `node scripts/testnet-usdcx-stream-probe.mjs --dry-run --target testnet --asset-key usdcx` resolves `instrumentId=USDCx` + admin/depository from the registry (verified 2026-06-11) |
| Placeholder guard | Pre-flight (`scripts/lib/preflight.mjs`) flags the `TBD::`/`TBD-` values in the `usdcx` entry: warning on DevNet/TestNet, **hard error on `--target mainnet`** (verified 2026-06-11) |

## 3. Per-network resolution: admin party + registry endpoint

The `usdcx` registry entry ships with explicit `TBD::`/`TBD-` placeholders
(they intentionally trip the pre-flight guard). Resolve them per network
before a live run:

1. **Issuer admin party** (`instrumentIdV2.admin` + `adminParty`):
   deployment-specific. Resolve from the issuer's published token-standard
   metadata, or locate the issuer via the public SV network status listing
   (<https://canton.foundation/sv-network-status-2/>). Do not guess — the
   party id includes a network-specific fingerprint.
2. **Registry endpoint** (`tokenStandardApiUrl`): USDCx runs a dedicated
   registry app (unlike Amulet, whose registry API is served by Scan).
   Resolve the base URL from the issuer's published metadata. The
   choice-context endpoints live under `/registry/allocations/v1/...` and
   `/registry/allocation-instruction/v1/...` on that base.
3. **SV Scan** (`scanEndpointUrl`): network-wide transaction history.
   TestNet reference is encoded in the entry
   (`https://scan.sv-1.test.global.canton.network.sync.global`); MainNet
   equivalent is `https://scan.sv-1.global.canton.network.sync.global`.
4. **Wallet gateway** (`walletGatewayUrl`): deployment-specific — each
   operator runs their own; point it at yours.

Cross-check after filling: `instrumentIdV2.id` stays `USDCx`; the admin
party in the registry must equal the `admin` on the issuer's live holding
contracts (query one sender holding and compare).

## 4. Live checklist (pending a funded USDCx party)

Blocked on: a sender party funded with USDCx on the target network, plus
the resolved issuer endpoints from §3. When both exist, run exactly this:

1. **Fill the registry entry.** Replace the four placeholder values in the
   `usdcx` entry of `config/asset-registry.json` (and mirror into
   `scripts/asset-registry-seeds.json`).
2. **Pre-flight (no writes):**

   ```bash
   CANTON_JSON_API_URL=http://<participant>:7575 \
   CANTON_LEDGER_TOKEN=$TOKEN \
   SENDER_PARTY=<funded-usdcx-party> RECIPIENT_PARTY=<recipient> ESCROW_PARTY=<operator> \
   node scripts/testnet-usdcx-stream-probe.mjs --dry-run --target testnet --asset-key usdcx
   ```

   Expected: the "Asset registry override" block prints
   `instrumentId=USDCx` and the resolved admin party; pre-flight reports
   **zero placeholder warnings** and `✓ pre-flight passed`, then exits
   before any ledger write.
3. **Record opening balances.** Sum the sender's and recipient's owned
   USDCx holdings (concrete-template ACS query with the package-name id —
   interface queries hit the JSON API 200-element cap; both lessons carry
   over from the CC run).
4. **One V1 allocation cycle** (the path field-proven with CC):

   ```bash
   CANTON_JSON_API_URL=http://<participant>:7575 \
   REGISTRY_API_URL=<usdcx-registry-base> \
   CC_ADMIN_PARTY=<usdcx-issuer-admin> INSTRUMENT_ID=USDCx \
   SENDER_PARTY=<funded-usdcx-party> RECIPIENT_PARTY=<recipient> EXECUTOR_PARTY=<operator> \
   AMOUNT=1.0 \
   node scripts/devnet-v1-cc-stream-probe.mjs
   ```

   Start with `DRY_RUN=true`. Auto-allocate needs the issuer's factory to
   accept `AllocationFactory_Allocate` from the sender; otherwise allocate
   in the sender's wallet UI and pass `ALLOCATION_CID`. Expected steps:
   factory resolution → allocate (locks USDCx, correlated by
   `settlementRef.id = <streamId>:cycle-<n>`) → execute-transfer choice
   context → `Allocation_ExecuteTransfer` → settled.
5. **Assert balances.** Recipient delta = +AMOUNT. Sender delta = −AMOUNT
   minus any issuer fee (record the observed fee; CC's was zero). No
   residual locked allocation for the settlement ref.
6. **Verify publicly.** Fetch each cycle's update id via
   `GET {scan-host}/api/scan/v2/updates/{update_id}` and record
   `record_time`, `synchronizer_id`, and root events in a run report under
   `docs/reports/` — same format as the CC report.
7. **Repeat for ≥2 cycles** against one stream id to demonstrate the
   per-withdrawal cycle cadence, then run the full lifecycle probe without
   `--dry-run`.

Authority model is unchanged from CC: `Allocation_ExecuteTransfer` is
controlled jointly by executor + sender + receiver; the probes submit with
all three in `actAs`, which requires co-hosting on one participant. For
separated topologies, compose the exercise inside a choice on a contract
signed by those parties (see [V1-LANE-TESTING.md](../V1-LANE-TESTING.md)).

## 5. After USDCx publishes V2

Per CIP-0112 §5, USDCx is expected to advertise V2 in `supportedApis`.
When it does: flip `allocationsV2`/`transferEventsV2` in the registry
entry (no code change), re-run the V2 probe
(`scripts/testnet-v2-stream-probe.mjs`), and retire this V1 checklist with
the lane.
