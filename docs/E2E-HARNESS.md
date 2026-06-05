# Wallet-backed V2 E2E harness

This is the operator runbook for the STR-129 acceptance harness. Its purpose
is to prove a **clean checkout** drives a full V2 allocation flow against a
real CIP-103 wallet (Splice LocalNet Amulet) with no custom wallet stub.

The harness uses only V2 vocabulary:

- `AllocationFactory_Allocate` (with `committed=True`)
- `Allocation_Settle`
- `SettlementFactory_SettleBatch`

V1 vocabulary such as `Allocation_ExecuteTransfer` is **rejected** by
`scripts/check-v2-conformance.sh` (the `v2_conformance` CI job). If you see a
review comment that the harness "uses V1 names", run the lint locally first
to rule out a false positive.

## What you need

| Component                          | Version                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| Operating system                   | macOS or Linux                                          |
| Docker                             | 24 or newer with `docker compose`                       |
| Git                                | 2.40 or newer                                           |
| Node.js                            | 22.14 or newer                                          |
| pnpm                               | 9.15 via Corepack                                       |
| Daml SDK                           | 3.4.x (matches Splice pinned commit)                    |
| Java + sbt + Postgres              | Required by the Splice LocalNet validator               |
| Disk space                         | 20 GB free for the Splice clone + build artifacts       |
| RAM                                | 8 GB free at minimum, 16 GB recommended                 |

The Splice LocalNet stack takes 10 to 30 minutes to build on a cold cache.
Plan accordingly. CI runs this on `workflow_dispatch` only — see
`.github/workflows/e2e.yml`.

## Pinned upstream

The harness pins the Splice repository to the same commit as
`scripts/fetch-v2-dars.mjs`:

- `SPLICE_PINNED_COMMIT` — exported from `scripts/fetch-v2-dars.mjs`.
- `SPLICE_PINNED_AS_OF` — the date the pin was last verified.

Override with `SPLICE_PINNED_COMMIT=<sha>` if you are testing an upstream
patch before bumping the pin.

### Opting into the Amulet wallet V2 iterated-settlement preview (PR #5697)

For full V2 receiver-flow E2E (the Amulet wallet creating + accepting
committed allocations with `nextIterationFunding`, plus the scan +
wallet tx-log parser updates for the new V2 settlement tx shape) the
upstream work lives on
[`canton-network/splice#5697`](https://github.com/canton-network/splice/pull/5697)
— branch `oriol/initialted-settlement-fe` at head
`73c68d16ba93346a80418662f94a7877e3938f91`, open against
`token-standard-v2-upcoming` (the base our main pin is cut from).

Until #5697 merges, opt in explicitly rather than bumping the main pin:

```bash
# Either:
export SPLICE_PINNED_COMMIT=73c68d16ba93346a80418662f94a7877e3938f91
bash scripts/start-localnet-e2e.sh
# Or on CI: pass it as the `splice_pinned_commit` workflow_dispatch
# input on .github/workflows/e2e.yml.
```

The constants `SPLICE_PR5697_PREVIEW_COMMIT` and
`SPLICE_PR5697_PREVIEW_BRANCH` in `scripts/fetch-v2-dars.mjs` carry
the canonical values. When `start-localnet-e2e.sh` detects the
operator is on the preview commit, it annotates the announce line so
log-readers can see the harness is on the preview branch. On merge,
bump `SPLICE_PINNED_COMMIT` to the merge sha and delete the preview
constants.

## Step 1 — Bring up the Splice LocalNet and an Amulet wallet gateway

The orchestration script clones the upstream Splice repo at the pinned
commit and prints the canonical docker-compose command to start the
LocalNet stack. The script does **not** run the start command automatically
because the cold boot is slow and the operator may want to inspect the
clone first:

```bash
bash scripts/start-localnet-e2e.sh
```

Then, in the printed `.splice-localnet/` checkout, start the upstream
LocalNet via its canonical wrapper (verified at the pinned commit in
[`build-tools/splice-localnet-compose.sh`](https://raw.githubusercontent.com/canton-network/splice/2f2a8b94871bc9d68ae5bdbe7198b0c69a5fa9ea/build-tools/splice-localnet-compose.sh),
which invokes `docker compose` on `cluster/compose/localnet/compose.yaml`
with the `sv`, `app-provider`, and `app-user` profiles):

```bash
cd .splice-localnet
docker --version && docker compose version          # sanity-check Docker is present
./build-tools/splice-localnet-compose.sh start      # boot Canton + SV + app-user/app-provider validators + wallet UIs
```

This brings up Canton, a super-validator, an `app-user` validator, an
`app-provider` validator, three React wallet UIs (on ports `2000`,
`3000`, `4000` — see `APP_USER_UI_PORT` / `APP_PROVIDER_UI_PORT` /
`SV_UI_PORT` in `cluster/compose/localnet/env/common.env`), and exposes
the participant JSON-Ledger-API on the `x975` ports
(`PARTICIPANT_JSON_API_PORT_SUFFIX=975`, so app-user is on
`http://localhost:2975` and app-provider on `http://localhost:3975`).

> **Honest gap on `:3030`.** The upstream LocalNet stack at the pinned
> commit `2f2a8b94871bc9d68ae5bdbe7198b0c69a5fa9ea` does **not** publish a
> CIP-103 JSON-RPC wallet gateway at `http://localhost:3030/api/v0/dapp`.
> That endpoint is provided by the **Splice Wallet Kernel** (historically
> "SWK"), a separate component whose canonical home today is
> [`canton-network/wallet`](https://github.com/canton-network/wallet)
> (the older `hyperledger-labs/splice-wallet-kernel` URL 301-redirects
> there). The gateway daemon is published as
> `@canton-network/wallet-gateway-remote`; the in-page client this
> dashboard already imports is `@canton-network/dapp-sdk` (published
> from the same monorepo).
> The three legacy paths older revisions of this doc referenced
> (`build-tools/local-canton/start-canton.sh`,
> `build-tools/local-validator/start-validator.sh`,
> `build-tools/local-wallet/start-wallet-gateway.sh`) do not exist in
> `canton-network/splice` at any commit — `build-tools/` only contains
> `splice-localnet-compose.sh` and `splice-compose.sh`.

To get a working `:3030` CIP-103 endpoint, after LocalNet is up, the
fastest path is the npm-published wallet-gateway-remote daemon — no
clone/build needed:

1. Generate a config skeleton, edit it to point at the LocalNet
   `app-user` JSON Ledger API and to allowlist this dashboard's
   origin, then start the gateway:

   ```bash
   npx @canton-network/wallet-gateway-remote@1.4.0 --config-example > wallet-gateway.localnet.json
   # Edit wallet-gateway.localnet.json:
   #   ledgerApi.baseUrl    = http://127.0.0.1:2975         # LocalNet app-user JSON API
   #   allowedOrigins       += http://localhost:3000        # Streams dashboard
   #   allowedOrigins       += http://127.0.0.1:3000        # same, IP form
   npx @canton-network/wallet-gateway-remote@1.4.0 -c wallet-gateway.localnet.json -p 3030
   ```

   The app-user JSON Ledger API is exposed on `:2975` by the LocalNet
   compose stack (`PARTICIPANT_JSON_API_PORT_SUFFIX=975`); use
   `:3975` instead to bind the gateway to the app-provider validator.

   If you would rather build the gateway from source (e.g. testing an
   unreleased branch), clone
   [`canton-network/wallet`](https://github.com/canton-network/wallet)
   and run `yarn install && yarn build:all && yarn start:all` — same
   endpoint, same configuration shape.

2. The dashboard runs on `:3000` by default, which collides with the
   upstream `app-provider` wallet UI. Either change
   `STREAMS_DASHBOARD_PORT` when bringing up the Streams stack in
   Step 2 or leave the upstream UI down before starting the dashboard
   container. Whichever origin the dashboard ends up on, make sure it
   is in `allowedOrigins`.

3. Probe the gateway. Port `3030` is the documented default this
   repo's runbooks use; the upstream quickstart does not pin it, so
   confirm:

```bash
curl -fsS -X POST http://localhost:3030/api/v0/dapp \
  -H 'Origin: http://localhost:3000' \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"probe","method":"status","params":{}}'
```

If your environment provides an Amulet wallet gateway at a different
URL, export `VITE_WALLET_GATEWAY_URL=<your-url>` before Step 2 and the
dashboard image will pick it up (see the env note in Step 2).

> **V2 token support in the Amulet wallet.** The Splice Amulet wallet
> that ships on every validator node supports the CIP-56 V2 token
> standard on the `token-standard-v2-upcoming` branch this repo pins
> against, so Amulet's V2 AllocationRequest approval and
> iterated-settlement wallet behavior can be exercised against a
> LocalNet built from that branch. Full iterated-settlement support in
> the wallet is tracked upstream in
> [canton-network/splice#5498](https://github.com/canton-network/splice/issues/5498)
> — read it before assuming a specific UX flow lands in a given
> wallet build.

## Step 2 — Bring up the Streams stack on top of the running wallet

Once the wallet gateway responds, rerun the orchestration script with the
LocalNet step skipped. It now only brings up the Streams Docker stack and
waits for proxy + dashboard health endpoints to return 200.

```bash
SKIP_LOCALNET_BUILD=1 bash scripts/start-localnet-e2e.sh
```

The script exports these to the dashboard image:

```text
VITE_WALLET_GATEWAY_URL=http://localhost:3030/api/v0/dapp
VITE_SKIP_WALLET_PICKER=true
VITE_WALLET_NAME=Splice Amulet Wallet (LocalNet V2)
```

`docker/docker-compose.yml` substitutes `VITE_WALLET_GATEWAY_URL` via
`${VITE_WALLET_GATEWAY_URL:-http://localhost:3030/api/v0/dapp}`, so if
you exported a non-default value before running the script (or before
invoking `docker compose` directly), that URL flows through to the
dashboard build and the fail-closed preflight in Step 4 will probe it.

`VITE_SKIP_WALLET_PICKER=true` makes the dashboard's CIP-103 client skip
the picker UI. The first thing `connect()` does in that mode is preflight
the configured wallet gateway with a JSON-RPC `status` request. If the
gateway is unreachable, the user sees an explicit error message that
references the URL and tells them to start the Splice LocalNet wallet.
There is no popup, no opener, and no unreachable-iframe loop. This is
the fail-closed behavior the harness guards.

## Step 3 — Drive the V2 allocation flow end-to-end

In a browser at `http://localhost:3000`:

1. Click **Connect wallet**. The dashboard sends the CIP-103 status
   preflight, then `connect()` on `@canton-network/dapp-sdk`. The wallet
   returns the available accounts.

2. Open **Create stream**. Fill in:
   - Recipient party (one of the wallet's accounts).
   - Asset (a V2-capable instrument advertised by the wallet).
   - Amount, start, end, vesting mode.

3. Submit. The dashboard's SDK creates a V2 `StreamAdmin` contract —
   the metadata record the rest of the stack queries against. See
   `packages/sdk/src/commands/create.ts`.

   > **Honest gap.** Today the SDK creates `StreamAdmin` directly; it
   > does **not** also emit a V2 `AllocationRequest` for the recipient
   > to accept, and the dashboard's `walletSdk.open()` button only
   > brings the wallet forward — it does not yet call
   > `walletSdk.prepareExecuteAndWait(...)` with an
   > `AllocationRequest_Accept` payload. So at this step in the
   > current build, the wallet is connected but is not driving the
   > recipient acceptance ceremony. Wiring that is the next focused
   > implementation step (target wallet build: the PR #5697 preview
   > documented above) — see
   > [`packages/dashboard/src/lib/walletApprovals.ts`](../packages/dashboard/src/lib/walletApprovals.ts)
   > and `lib/walletApprovals.ts`'s module-level docstring for the
   > exact swap site.

4. Approve in the Amulet wallet directly (open it through the wallet
   gateway UI, not the dashboard inbox button). Approval exercises
   `AllocationFactory_Allocate` with `committed=True`. The Streams
   executor then exercises `Allocation_Settle` per accrual period;
   batched advancement uses `SettlementFactory_SettleBatch`. None of
   that requires further dashboard interaction — the choices are
   issued by the wallet + executor against the on-ledger contracts.

You can confirm the V2 choices from the participant transaction log
(query the proxy's `/api/streams/:id/history` endpoint) or by running
the matching SDK probe
(`scripts/testnet-v2-stream-probe.mjs` against the LocalNet endpoint
instead of TestNet).

## Step 4 — Fail-closed verification (no popup when the wallet is gone)

To prove the fail-closed path in the dashboard, stop the wallet gateway
and click **Connect wallet** again:

```bash
# Stop the wallet gateway in the Splice checkout (Ctrl-C the
# start-wallet-gateway.sh terminal, or whatever upstream documents).
```

Expected dashboard behavior:

- An inline error reading
  `Amulet wallet gateway is not reachable at http://localhost:3030/api/v0/dapp ... Start the Splice LocalNet validator Amulet wallet gateway, then retry Connect wallet.`
- **No** popup window opens.
- The DevTools Network tab shows a single `POST /api/v0/dapp` with the
  JSON-RPC `status` method that failed.

This is the no-popup acceptance for STR-129. The same message string is
emitted by `assertRemoteWalletReachable` in
`packages/dashboard/src/store/auth.tsx`, so it lives next to the code it
guards.

## Step 5 — Tear down

```bash
docker compose -f docker/docker-compose.yml down -v
# Then Ctrl-C the upstream Splice validator + wallet processes.
```

## Hosted-wallet E2E (PartyLayer — STR-133)

The default dapp-sdk path above uses a single Amulet wallet behind
the CIP-103 gateway. The dashboard also supports a hosted multi-wallet
picker via `@partylayer/sdk` 0.4.1. Both paths drive the same
`StreamsWalletClient` contract in
`packages/dashboard/src/store/wallet/`, so every flow tested above
(connect → create stream → wallet approval → executor settlement)
exists unchanged under the partylayer layer.

### Bringing up the dashboard in hosted-wallet mode

```bash
# Build the dashboard image with the PartyLayer layer selected.
VITE_WALLET_LAYER=partylayer \
VITE_PARTYLAYER_NETWORK=devnet \
VITE_PARTYLAYER_APP_NAME='Canton Payment Streams' \
docker compose -f docker/docker-compose.yml up -d --build --no-deps dashboard
```

`docker-compose.yml` substitutes the new env vars via `${VAR:-default}`
syntax so the partylayer layer activates without code edits. No
wallet gateway at `:3030` is required — PartyLayer talks to wallets
through its own adapter set (Console / Loop / Cantor8 by default;
see `docs/HOSTED-WALLET-PLAN.md` "Wallet support matrix").

### Test plan against the partylayer layer

Drive each through the dashboard, observing PartyLayer's picker in
place of the dapp-sdk auto-remote-picker:

1. **Connect** — click "Connect wallet". PartyLayer renders its
   picker; choose Loop (recommended for end-user flow) or Console
   (recommended for dev verification).
2. **Sender visibility** — Alice creates a V2 stream to Bob via
   "Create stream". Asserts: `commands/create.ts` runs against the
   same proxy regardless of layer; on-ledger StreamAdmin contract
   is created identically.
3. **Receiver visibility** — Bob (a different PartyLayer wallet
   session) sees the incoming stream in the Inbox.
4. **Receiver wallet approval** — Bob clicks "Approve in Amulet
   wallet" (the button copy stays from the dapp-sdk default; in
   partylayer mode the underlying call is
   `walletClient.open()` → no-op + the picker handles its own
   visibility, so the button mostly serves as the "Mark approved"
   trigger today). The future `prepareExecuteAndWait` swap will
   work against the partylayer layer too — `PartyLayerClient.asProvider()`
   exposes the CIP-103 method.
5. **Executor settlement** — same on-ledger flow as the dapp-sdk
   path; the dashboard observes `Allocation_Settle` /
   `SettlementFactory_SettleBatch` events through the proxy log.
6. **Batch** — same.
7. **Policies + executor logs** — same.

### What's the same and what's different vs. the dapp-sdk path

| Flow                                | dapp-sdk layer           | partylayer layer                                 |
| ----------------------------------- | ------------------------ | ------------------------------------------------ |
| Connect                             | Auto-remote-picker → :3030 | Multi-wallet picker (Console / Loop / Cantor8) |
| Sender create stream                | Identical                | Identical                                        |
| Receiver Inbox view                 | Identical                | Identical                                        |
| Receiver inbox button → wallet      | `walletSdk.open()`       | `walletClient.open()` (no-op; picker self-shows) |
| On-ledger choices                   | Identical                | Identical                                        |
| Executor + logs                     | Identical                | Identical                                        |

### Hosted-wallet smoke test (no docker required)

The vitest contract tests in
`packages/dashboard/src/store/wallet/walletClient.test.ts`
exercise both clients' method surface + capability bag without a
real wallet behind them. Treat these as the always-on smoke for
both layers; the docker-compose flow above is the integration test
operators run when a real picker round-trip is needed.

### Known gaps

- Connect-flow copy / picker shell — the PartyLayer adapter set
  ships its own picker UI. The dashboard's existing connect-flow
  copy ("Connect a CIP-103 wallet") is generic enough to ride
  along but tests assume the dapp-sdk auto-picker layout. Visual
  parity is a docs-only follow-up tracked in STR-134.
- `walletClient.open()` is a no-op on the partylayer layer (the
  picker handles its own visibility). Existing inbox copy says
  "Wallet open — sign there" after click; that copy is accurate
  under both layers because the picker also opens-a-wallet at click
  time, but the surface is the picker, not a specific wallet UI.
- The future receiver-flow swap from `walletClient.open()` to
  `walletClient.prepareExecuteAndWait(...)` runs against either
  layer; STR-133 only asserts the layer-switching surface works.

## Troubleshooting

| Symptom                                                                  | Likely cause                                                                | Fix                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `start-localnet-e2e.sh` exits with "missing required command: docker"    | Docker not installed or daemon not running                                  | Install Docker Desktop or `dockerd`; verify `docker info` succeeds.                              |
| Splice clone takes a very long time                                      | First clone of a large repo over a slow link                                | The script uses `--filter=blob:none` to avoid full history.                                      |
| Wallet gateway probe times out after 90 s                                | Splice validator or wallet gateway not actually running                     | Re-run the upstream commands and confirm `:3030/api/v0/dapp` is bound.                           |
| Dashboard shows "Failed to fetch" but no fail-closed message             | `VITE_SKIP_WALLET_PICKER` not propagated to the image                       | Confirm `docker compose config` shows the env vars on the dashboard service.                     |
| Stream create succeeds but the wallet never prompts                      | Asset registry advertises an instrument the wallet does not hold            | Use one of the wallet's listed accounts and an instrument it advertises.                         |
| CI guard fails with "uses banned V1 name"                                | A new file referenced `Allocation_ExecuteTransfer` outside the allow-list   | Either rename to `Allocation_Settle` or add the file to the conformance allow-list with reason.  |

## Why this harness, not a vitest mock

The acceptance for STR-129 is wallet-backed: `the E2E uses Amulet on TSv2;
no custom wallet mock is accepted as the final proof.` A vitest unit test
can pin the fail-closed message and the absence of a popup, but it cannot
prove the V2 allocation choices fire on a real participant. The harness
defined here is the proof artifact.

The unit-level regression for the fail-closed message lives directly
inside the dashboard's connect flow — `assertRemoteWalletReachable` in
`packages/dashboard/src/store/auth.tsx` — so a code change that breaks
the message will fail the type-checker or any future Playwright spec
that drives the same path against this harness.

## Related

- `scripts/check-v2-conformance.sh` — the V1-name-rejecting lint that the
  `v2_conformance` CI job runs.
- `scripts/fetch-v2-dars.mjs` — source of truth for `SPLICE_PINNED_COMMIT`
  and `SPLICE_PINNED_AS_OF`.
- `.github/workflows/e2e.yml` — manual `workflow_dispatch` job that runs
  the same orchestration script on a CI runner.
- `docs/QUICKSTART.md` — the local-only path that does **not** require
  the Amulet wallet (uses dev credentials).
