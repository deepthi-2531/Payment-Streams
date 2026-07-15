# Canton Payment Streams — Integration Guide

Integrate time-based CC payouts (vesting, payroll, LP incentives, recurring billing)
into your Canton dApp. Your stream terms stay **private to your parties**; only the
asset settlements are publicly visible — stamped so usage is independently countable.

Field-validated end-to-end on **TestNet and MainNet** (2026-06-10): Linear, Stepped, and
custom-curve streams settled real CC, including a production MainNet run
(DAR vetted, on-ledger stream completed, usage discovered on public Scan).

---

## What you run vs. what the library provides

| Component | Who runs it |
| --- | --- |
| Canton validator + participant (Splice) | **You** (you already have one if you're on Canton) |
| `canton-streams` DAR (stream contracts) | **You** upload to your participant |
| `@canton-streams/sdk` + executor loop | **You** (npm package + reference scripts) |
| Token-standard registry API | The network (served by **Scan** for CC) |
| Usage measurement | Reproducible by anyone from public Scan; no access to your systems needed |

There is no hosted facilitator and no third party in your money path: your parties,
your participant, the network's registry. The library never holds funds or keys.

## Prerequisites

- Canton validator on the target network (TestNet/MainNet), participant JSON Ledger
  API **v2** reachable from your backend (Canton 3.5+: `GET /v2/version`).
- **Auth.** Production validators run the Ledger API with auth ON. Mint a bearer
  token via your validator's OAuth client-credentials (audience
  `https://canton.network.global`) and pass it as `CANTON_LEDGER_TOKEN`:

  ```bash
  curl -s https://<your-tenant>/oauth/token -H 'Content-Type: application/json' \
    -d '{"client_id":"…","client_secret":"…","audience":"https://canton.network.global","grant_type":"client_credentials"}'
  ```

  When the token carries user claims, do **not** also pass `CANTON_USER_ID`.
  (Auth disabled, e.g. LocalNet: no token, but an explicit `userId` IS required.)
- A ledger user with `actAs` rights for your sender/operator parties.
- Sender party funded with CC.
- Network endpoints:

```
TestNet SCAN/REGISTRY: https://scan.sv-1.test.global.canton.network.sync.global
MainNet SCAN/REGISTRY: https://scan.sv-1.global.canton.network.sync.global
                  (registry endpoints live at /registry/... on the BARE host — not /api/scan)
DSO (CC admin):   GET {scan}/api/scan/v0/dso-party-id
SYNCHRONIZER:     GET {scan}/api/scan/v0/synchronizer-id (per network)
```

## 1. Install

```bash
npm i @canton-streams/sdk
```

## 2. Deploy the streams DAR

The DAR **must be built against the official Splice release DARs** (the exact
package ids vetted on the network) — source-built token-standard interface DARs
hash differently and the upload fails with `KNOWN_PACKAGE_VERSION`. Extract the
official ones from your validator-app image into `packages/daml/main/.lib/`
before building (same recipe as `packages/daml/v1-shim/daml.yaml` documents):

```bash
CID=$(docker create ghcr.io/digital-asset/decentralized-canton-sync/docker/validator-app:<your-version>)
docker cp $CID:/app/splice-node/dars/splice-api-token-metadata-v1-1.0.0.dar packages/daml/main/.lib/
docker rm $CID
cd packages/daml/main && daml build
```

App-level OAuth tokens are usually **not** participant admins (`403` on
`/v2/packages`) — upload via the participant **admin API** instead, as the
validator operator (verified on MainNet):

```bash
# on the validator host; participant admin port 5002
B64=$(base64 -w0 canton-streams-<version>.dar)
printf '{"dars":[{"bytes":"%s"}],"vet_all_packages":true,"synchronize_vetting":true}' $B64 > /tmp/up.json
docker run --rm --network host -i fullstorydev/grpcurl -plaintext -max-msg-sz 104857600 \
  -d @ <participant-ip>:5002 com.digitalasset.canton.admin.participant.v30.PackageService/UploadDar < /tmp/up.json
```

## 3. Create a stream

A stream is one on-ledger contract holding the payout schedule. Both parties sign
creation (propose/accept — recipient consent is required by design).

```ts
import { CantonStreamsClient, VestingMode } from '@canton-streams/sdk';

const client = new CantonStreamsClient({
  host: '<participant>', port: 7575, actAs: [SENDER, RECIPIENT],
});

await client.createStream({
  streamId: 'payroll-alice-2026-07',
  sender: TREASURY_PARTY,
  recipient: ALICE_PARTY,
  operator: TREASURY_PARTY,          // who drives settlement cycles
  totalDeposited: '3000.0',
  vestingMode: VestingMode.Stepped,  // Linear | CliffLinear | Stepped | RenewableTerm
  // Stepped → fixed installments: stepInterval + amountPerStep
  // Linear  → continuous flow: chunk = rate × time-since-last-withdrawal
  startTime: new Date('2026-07-01T00:00:00Z'),
  endTime: new Date('2026-07-31T00:00:00Z'),
  cancellable: true,
});
```

Pick the mode by payout shape: **Stepped** = identical installments (payroll,
subscriptions); **Linear** = continuous accrual harvested on demand (LP incentives,
retainers); **CliffLinear** = vesting with cliff; **RenewableTerm** = rolling terms.
Custom curves (e.g. exponential) run as executor-side schedules on the same engine.

## 4. Settle cycles (each withdrawal = one CC settlement)

Until CC publishes CIP-56 V2 interfaces, each withdrawal cycle is one **V1
allocation round-trip**, fully automatable. Reference implementation:
[`scripts/devnet-v1-cc-stream-probe.mjs`](../../scripts/devnet-v1-cc-stream-probe.mjs)
(one command = one cycle) and the executor demos in the report. Per cycle:

```text
1. registry: POST {scan}/registry/allocation-instruction/v1/allocation-factory
     → factoryId + choice context + disclosed contracts
2. ledger:   exercise AllocationFactory_Allocate as SENDER
     (locks the chunk; settlementRef.id = "<streamId>:cycle-<n>";
      attribution meta is stamped automatically by the SDK)
3. registry: POST {scan}/registry/allocations/v1/{cid}/choice-contexts/execute-transfer
4. ledger:   exercise the allocation's execute-transfer choice
     actAs [executor, sender, recipient]  ← joint controllers (see note)
5. ledger:   exercise Sync_Iteration on the stream contract
     (records the chunk; enforces withdrawn ≤ deposited; auto-Completes)
```

Run it on a schedule (cron/executor) with the chunk = your stream's accrual at
that moment — the SDK exposes the accrual math (`getBalances`).

```bash
# one cycle, end to end (settlement-only mode shown)
SKIP_SHIM=true CANTON_USER_ID=administrator \
CANTON_JSON_API_URL=http://<participant>:7575 \
REGISTRY_API_URL=https://scan.sv-1.test.global.canton.network.sync.global \
CC_ADMIN_PARTY=<dso-party> \
SENDER_PARTY=<sender> RECIPIENT_PARTY=<recipient> EXECUTOR_PARTY=<operator> \
STREAM_ID=payroll-alice-2026-07 CYCLE=3 AMOUNT=100.0 \
node scripts/devnet-v1-cc-stream-probe.mjs
```

> **Authority note:** the V1 execute-transfer choice is jointly controlled by
> executor + sender + receiver. Co-hosted parties (one participant): pass all three
> in `actAs` — done. Split topologies: compose the exercise in a Daml choice on a
> contract signed by those parties (see [`V1-LANE-TESTING.md`](../V1-LANE-TESTING.md)
> for the composition pattern).

## 5. Attribution & usage reporting (how your usage gets counted)

Every allocation the SDK builds is stamped with attribution metadata on the
**asset leg** (publicly visible on Scan because the DSO administers CC — your
stream contracts stay private):

```
settlement.meta["cantonstreams.dev/ref"] = "<streamId>:cycle-<n>"
settlement.meta["cantonstreams.dev/v"]   = "1"
```

That's the whole integration cost of being counted: **zero** — it's automatic.
Don't strip the keys; they're how your usage contributes to the ecosystem metrics
(and, post-CIP-104, how burn-indexed featured-app rewards attribute to providers).

**Set your app id** (one env var) so your usage is attributed to *your team* in
reports rather than to your party prefix:

```bash
export CANTON_STREAMS_APP_ID=your-app-name     # stamped as cantonstreams.dev/app
```

The usage numbers are reproducible by anyone from public Scan with no privileged
access:

```bash
SCAN_URL=https://scan.sv-1.test.global.canton.network.sync.global \
SINCE=2026-07-01T00:00:00Z UNTIL=2026-08-01T00:00:00Z \
node scripts/scan-usage-report.mjs
# → settlements count, distinct streams, total settled, update-id evidence list
```

## Troubleshooting (all hit and fixed in live integration)

| Error | Fix |
| --- | --- |
| `missing a user-id: claims do not specify an user-id` | Pass `userId` (e.g. `administrator`) in commands / `CANTON_USER_ID` |
| `Invalid field packageId: … expected a package name` | ACS **filters** need `#package-name:Module:Entity` ids; raw package ids are command-only |
| `wrong type, expecting array at 'commands'` | `/v2/commands/submit-and-wait` takes `JsCommands` fields at the TOP level of the body |
| `Expected ujson.Str (data: 0)` | Daml `Int64`/`Decimal` are **strings** in DA-JSON (`"0"`, `"1.0"`) |
| `404` on `/registry/allocation-instruction/...` | Registry base is the **bare Scan host**, not `…/api/scan` |
| `JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED` | Query concrete templates (`#splice-amulet:Splice.Amulet:Amulet`), not broad interfaces |
| `DAML_AUTHORIZATION_ERROR` on stream create | Stream creation needs sender **and** recipient in `actAs` (consent by design) |
| `KNOWN_PACKAGE_VERSION` on DAR upload | DAR bundles source-built interface packages, or pre-existing duplicate on your participant — see §2 |
| `403` "security-sensitive error" on `/v2/packages` | App OAuth token isn't participant admin — upload via admin API (§2) |
| Usage report finds nothing on MainNet | Synchronizer migration id: the update cursor is `(migration_id, record_time)` — `scan-usage-report.mjs` auto-detects; override with `MIGRATION_ID` |
| Settled but chunks "wrong size" | Check `vestingMode`: Linear chunks = rate × elapsed (unequal is correct); use Stepped for identical installments |

## Support

- Field notes: [`docs/V1-LANE-TESTING.md`](../V1-LANE-TESTING.md)
- Issues: GitHub issues on this repo. Integration-blocking bugs during pilots are prioritized.
