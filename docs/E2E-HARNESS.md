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

## Step 1 — Bring up the Splice LocalNet Amulet wallet

The orchestration script clones Splice at the pinned commit and prints the
exact upstream commands to start Canton, the validator, and the wallet
gateway. The script does **not** run those commands automatically because
they depend on tools not all hosts have (sbt, Postgres) and they take a
long time:

```bash
bash scripts/start-localnet-e2e.sh
```

Then, in the printed `.splice-localnet/` checkout, run the upstream
commands (these are the ones the Splice repository documents; copy them
verbatim from the script output to avoid drift):

```bash
cd .splice-localnet
./build-tools/local-canton/start-canton.sh
./build-tools/local-validator/start-validator.sh
./build-tools/local-wallet/start-wallet-gateway.sh
```

When the wallet gateway is up, you should see a successful CIP-103 status
response:

```bash
curl -fsS -X POST http://localhost:3030/api/v0/dapp \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"probe","method":"status","params":{}}'
```

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
3. Submit. The Streams SDK emits an AllocationRequest and the wallet
   prompts you to approve. Approval exercises
   `AllocationFactory_Allocate` with `committed=True`.
4. The Streams executor subsequently exercises `Allocation_Settle` per
   accrual period. Batched advancement uses
   `SettlementFactory_SettleBatch`.

You can confirm the V2 choices from the participant transaction log
(query the proxy's `/api/streams/:id/history` endpoint) or by running the
matching SDK probe (`scripts/testnet-v2-stream-probe.mjs` against the
LocalNet endpoint instead of TestNet).

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
