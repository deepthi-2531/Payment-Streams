# Testing the transitional V1 lane on LocalNet / DevNet / TestNet

> **Status:** the V1 lane (`splice-api-token-allocation-v1`) is transitional.
> It exists so Canton Coin (Amulet) and USDCx — live on MainNet today but not
> yet publishing CIP-0112 V2 interfaces — can settle streams now. It is
> deprecated from birth; see "V1 lane retirement" in [CHANGELOG.md](../CHANGELOG.md).
>
> **Validated on TestNet (2026-06-10):** three full allocate → execute-transfer
> cycles settled real CC on the Canton TestNet global synchronizer via a
> partner validator (see `docs/reports/first-dapp-integration-testnet.md`).
> Field-verified specifics are folded into the notes below.

## Field notes from the TestNet run (read these first)

- **Registry API base for Amulet = the bare Scan host**, NOT `…/api/scan`.
  Example: `REGISTRY_API_URL=https://scan.sv-1.test.global.canton.network.sync.global`.
  The choice-context endpoints live at `/registry/allocations/v1/...` on that host.
- **JSON Ledger API is v2-only on Canton 3.5** (`/v2/commands/submit-and-wait`
  takes the `JsCommands` fields at the top level of the body). With participant
  auth disabled you must still pass an explicit `userId` (e.g. the validator's
  `administrator` user).
- **ACS filters require package-NAME ids** (`#splice-amulet:Splice.Amulet:Amulet`);
  raw package-id identifiers are rejected for queries (commands accept both).
- **Prefer concrete-template queries over interface queries** for holdings and
  allocations: interface queries hit the JSON API 200-element list cap on
  validator-operator parties (they observe many holdings as lock holders) and
  are ambiguous when two token-standard package generations are vetted.
- **Package-generation wedge:** a participant that has BOTH an old and a new
  build of the token-standard interface packages vetted (same name+version,
  different package ids) rejects ALL new DAR vetting under Canton 3.5 strict
  validation (`KNOWN_PACKAGE_VERSION`). The allocate/execute cycle works
  regardless (it only touches already-vetted packages) — run the probe with
  `SKIP_SHIM=true`. Resolving the wedge (to vet the shim DAR) requires
  unvetting the stale generation or hosting on a clean participant.
- The factory returned by Scan for Amulet is `ExternalPartyAmuletRules`
  (implements `AllocationFactory`); disclosed contracts arrive with exact
  template ids and synchronizer id — pass them straight through.

## What ships

| Piece | Where |
| --- | --- |
| V1 builders + dispatcher (`dispatchSettlementV1`) | `packages/sdk/src/commands/allocation-v1.ts`, `packages/sdk/src/settlement/allocation-dispatch.ts` |
| Registry choice-context fetcher | `packages/sdk/src/settlement/choice-context.ts` |
| Disclosed-contract support (gRPC + JSON API) | `packages/sdk/src/transport/*` |
| On-ledger V1 request shim (separate DAR) | `packages/daml/v1-shim` → `canton-streams-v1-shim-1.0.0.dar` |
| One-cycle probe | `scripts/devnet-v1-cc-stream-probe.mjs` |

## Prerequisites

1. **Fetch interface DARs** (also builds the V1 set now):

   ```bash
   node scripts/fetch-v2-dars.mjs
   ```

2. **Build + upload the shim DAR** to the participant that hosts the
   stream operator party:

   ```bash
   cd packages/daml/v1-shim && daml build
   daml ledger upload-dar .daml/dist/canton-streams-v1-shim-1.0.0.dar --host <participant> --port <ledger-port>
   ```

3. **Verify interface package ids.** The shim implements the V1
   interfaces from `packages/daml/main/.lib/`. On DevNet/TestNet those
   packages are already vetted (Amulet implements them) — the locally
   fetched DARs must hash-match the on-ledger ones, or wallets will not
   see the shim's requests. Compare with `daml damlc inspect-dar` against
   the package ids visible on the network.

4. **Registry entry.** Fill the `cc` placeholder in
   `config/asset-registry.json` with the target network's DSO party,
   Scan URL, and wallet-gateway URL (`allocationsV1: true` is already set).

## Run one full cycle

```bash
CANTON_JSON_API_URL=http://localhost:7575 \
CANTON_LEDGER_TOKEN=$TOKEN \
REGISTRY_API_URL=<scan-base-url>/api/scan \
CC_ADMIN_PARTY=<dso-party> \
SENDER_PARTY=<sender> RECIPIENT_PARTY=<recipient> EXECUTOR_PARTY=<operator> \
AMOUNT=25.0 \
node scripts/devnet-v1-cc-stream-probe.mjs
```

Start with `DRY_RUN=true` to print the plan. The probe:

1. creates a `StreamAllocationRequestV1` (settlement ref `<streamId>:cycle-<n>`),
2. waits for the sender's V1 `Allocation` — either allocate in the sender's
   wallet UI and pass `ALLOCATION_CID=...`, or set `ALLOCATION_TEMPLATE_ID`
   (e.g. the Amulet allocation template) so the probe can poll,
3. fetches the `execute-transfer` choice context from the registry API,
4. exercises `Allocation_ExecuteTransfer` with the context in
   `extraArgs.context` and the registry's disclosed contracts on the command,
5. archives the shim request.

## Authority model (read before TestNet)

V1 `Allocation_ExecuteTransfer` is controlled **jointly by executor,
sender, and receiver**. The probe submits with all three in `actAs`,
which works when the parties are co-hosted on one participant (LocalNet,
DevNet probes, single-operator pilots). For separated topologies,
compose the exercise inside a Daml choice on a contract signed by those
parties (the stream workflow contracts are signed by sender + recipient
and are the natural host) — that composition is the production-hardening
step that follows a successful probe.

## SDK usage (programmatic, instead of the probe)

```ts
import {
  dispatchSettlementV1,
  fetchAllocationChoiceContext,
  resolveSettlementVersion,
  TEMPLATE_V1_ALLOCATION_REQUEST,
} from '@canton-streams/sdk';

const caps = getAssetCapabilities(registry, 'cc');     // allocationsV1: true
resolveSettlementVersion(caps);                        // → 'v1'

// 1. emit the per-cycle request
await dispatchSettlementV1(transport, caps, {
  action: 'emit-request',
  request: { requestedBy: operator, settlement, legs: [{ legId: 'leg-1', leg }] },
  templateId: TEMPLATE_V1_ALLOCATION_REQUEST,
  actAs: [operator],
}, logger);

// 2. (sender's wallet allocates)

// 3. fetch context + settle
const context = await fetchAllocationChoiceContext({
  registryApiUrl, allocationId: allocationCid, action: 'execute-transfer',
});
await dispatchSettlementV1(transport, caps, {
  action: 'settle',
  allocationCid,
  templateId: V1_ALLOCATION_INTERFACE_ID,
  actAs: [executor, sender, recipient],   // see authority model above
  context,
}, logger);
```

Iterated and batch actions are V2-only and fail loudly on the V1 lane —
recurring streams run one cycle per withdrawal.
