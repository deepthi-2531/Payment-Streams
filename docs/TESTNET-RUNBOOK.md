# TestNet Runbook — CC + USDCx Stream Lifecycle Probes

This runbook walks an operator through running the Canton Payment
Streams probes against a real Canton TestNet (or DevNet) participant.
**Do not run the steps below against mainnet** until the M3 audit is
complete (STR-24) and Critical/High findings are closed. The probes
include guards that block mainnet runs without explicit confirmation,
but operator discipline is the primary defense.

---

## 0. What you'll exercise

| Probe                                | Asset(s)    | Settlement path                  | Network |
|--------------------------------------|-------------|----------------------------------|---------|
| `testnet-v2-stream-probe.mjs`        | V2-native asset | V2 AllocationRequest / Allocation_Settle | V2-DevNet |
| `testnet-token-standard-stream-probe.mjs` | Registered V2 token-standard asset | V2 AllocationRequest | DevNet, TestNet |
| `testnet-cc-stream-probe.mjs`        | CC sandbox fixture | Legacy smoke only; not a production V2 gate | DevNet |

The production path is V2-only. Legacy V1/TokenStandardCustody probes
are retained only as historical smoke tooling and should not be treated
as acceptance evidence for this release.

---

## 1. Pre-flight always works

Every probe accepts `--dry-run` and `--target <network>` flags. These
do a comprehensive pre-flight check and exit BEFORE any ledger writes.
You should run `--dry-run` first to validate your environment:

```bash
# Smoke-test the env against your TestNet endpoint
node scripts/testnet-usdcx-stream-probe.mjs --dry-run --target testnet --asset-key cc
```

The pre-flight verifies:

- ✅ JSON Ledger API is reachable at `CANTON_JSON_API_URL`
- ✅ JWT (`CANTON_LEDGER_TOKEN`) decodes and is not expired
- ✅ Package id (`CANTON_STREAMS_PACKAGE_ID`) is vetted on the participant
- ✅ Sender / recipient / escrow parties are visible to the participant
- ✅ Asset registry routing for the `--asset-key` resolves correctly
- ⚠ Warns on `TBD::` placeholders in the asset registry
- ✗ **Refuses to run on mainnet** without `I_HAVE_MAINNET_CREDENTIALS=true`

---

## 2. Environment setup

### 2.1 Canton participant (TestNet)

You need a Canton participant with:

- A `:7575` JSON Ledger API endpoint (HTTPS recommended)
- A `:5001` (or similar) gRPC Ledger API endpoint
- The canton-streams DARs uploaded + vetted
- A funded wallet on the asset under test (CC, USDCx, etc.)
- A service-account user with `actAs` permission for sender/recipient/escrow parties

Validator providers offering TestNet participants include Digital
Asset's hosted validator service and several SV operators. The Canton
Foundation maintains a list at
<https://canton.foundation/sv-network-status-2/>.

### 2.2 DAR vetting

Build the canton-streams DARs:

```bash
daml build --project-root packages/daml/main
daml build --project-root packages/daml/interfaces
```

Upload + vet the resulting DARs against your participant:

```bash
daml ledger upload-dar \
  --host <participant-host> \
  --port 5001 \
  --tls \
  --access-token-file <token-file> \
  packages/daml/main/.daml/dist/canton-streams-0.2.8.dar
```

Then build the canonical manifest so the probes can verify template ids:

```bash
node scripts/build-template-manifest.mjs
```

The package id you'll need is in
`packages/daml/main/.daml/dist/canton-streams-0.2.8.dar.hash` or
visible in the manifest output.

### 2.3 Party allocation

Allocate (or reuse) three parties for the probe:

```bash
daml ledger allocate-party \
  --host <participant-host> \
  --port 5001 \
  --tls \
  --access-token-file <token-file> \
  cc-probe-sender

# Repeat for cc-probe-recipient and cc-probe-escrow
```

Capture the returned party identifiers (format `ParticipantName::ParticipantHash`).

### 2.4 JWT auth

For authenticated participants, obtain a JWT scoped to your parties.
The Canton docs cover this:
<https://docs.digitalasset.com/build/3.4/canton/usermanual/console.html#json-web-tokens>

Set the JWT as `CANTON_LEDGER_TOKEN`. The probe's pre-flight decodes
the JWT and warns if it's about to expire.

### 2.5 Asset registry

Populate `config/asset-registry.json` with real TestNet identifiers for
the asset under test. The `cc` entry currently has placeholders:

```json
{
  "key": "cc",
  "instrumentRef": {
    "depository": "TBD::cc-depository",  ← replace
    "issuer": "TBD::cc-issuer",          ← replace
    "instrumentId": "CC",
    "instrumentVersion": "1.0"
  },
  "adminParty": "TBD::cc-admin",         ← replace
  ...
}
```

Source the real values from:
- The SV network status page (linked above) for the asset admin parties
- Your participant's contract listing for the depository party
- The instrument admin's documentation for the instrument id + version

Once populated, save and re-run `--dry-run` to confirm the pre-flight
no longer flags placeholders.

---

## 3. Running the CC probe (sandbox accrual verification)

This probe creates a stream on the deployed DAR and verifies the
accrual math against the V2 `Allocation_Settle` chain. It does NOT
move real CC by itself; the V2 settle exercises do.

```bash
# Local DevNet (default endpoint from config/local.testnet.json)
node scripts/testnet-cc-stream-probe.mjs --target devnet

# Specific endpoint
CANTON_JSON_API_URL=https://devnet.example.com:7575 \
CANTON_LEDGER_TOKEN=$DEV_TOKEN \
CANTON_STREAMS_PACKAGE_ID=$PKG_ID \
node scripts/testnet-cc-stream-probe.mjs --target devnet --json
```

Expected output (full path):

```
========================================
 Canton Coin (CC) Stream Lifecycle Probe
 STR-30 / STR-78 — TokenStandardCustody verification
========================================

[ISO-time] API URL:           http://...
[ISO-time] Target network:    devnet
[ISO-time] Settlement mode:   numeric
[ISO-time] Package ID:        <hash>
[ISO-time] Stream ID:         cc-stream-<timestamp>
[ISO-time] Deposit amount:    100.0 CC
[ISO-time] Stream duration:   60s
[ISO-time] Dry-run:           false

────────── Pre-flight ──────────
  ledgerEnd: <some offset>
  packageVetted: true
  ✓ pre-flight passed
──────────────────────────────────

Step 1/4: submitting CreateStreamRequest…
  ✓ updateId:      <hex>
Step 2/4: recipient exercises AcceptStream…
  ✓ updateId:      <hex>
Step 3/4: waiting 65s for full vesting…
Step 4/4: recipient exercises Withdraw_Stream…
  ✓ updateId:      <hex>

Final state:
  status:          Completed
  totalWithdrawn:  100.0
  ...
```

If you see `pre-flight FAILED`, fix the listed errors before continuing.

---

## 4. Running the production probe (real CC / USDCx)

This probe uses TokenStandardCustody settlement — actual on-chain
transfers via the wallet-gateway. Required for any real CC or USDCx
flow (TestNet or eventual Mainnet).

### 4.1 CC on TestNet

```bash
# Build the SDK first (the probe imports from dist/)
pnpm --filter @canton-streams/sdk build

# Required env vars (excerpt — see full list at top of script):
export CANTON_JSON_API_URL=https://testnet.example.com:7575
export CANTON_LEDGER_TOKEN=$TESTNET_TOKEN
export CANTON_USER_ID=cc-probe-service
export SYNCHRONIZER_ID=global-domain::test
export CANTON_HOST=testnet.example.com
export CANTON_PORT=5001
export CANTON_USE_TLS=true
export CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID=<package-id>

export SENDER_PARTY=cc-probe-sender::testhash
export RECIPIENT_PARTY=cc-probe-recipient::testhash
export ESCROW_PARTY=cc-probe-escrow::testhash

# STR-90: Wallet Gateway connection is the only signing config
# required. The gateway holds the sender + recipient keys; the probe
# delegates prepare → sign → execute via SDK SigningProvider.
# In-process Ed25519 signing via node:crypto is gone — no more
# SENDER_PRIVATE_KEY / RECIPIENT_PRIVATE_KEY env vars.
export CANTON_STREAMS_WALLET_GATEWAY_URL=https://wallet.testnet.example.com/api/v0/dapp
export CANTON_STREAMS_WALLET_GATEWAY_TOKEN=$WALLET_GATEWAY_SESSION_TOKEN

# Optional — set if the gateway hosts a specific signing-provider
# kind (default: wallet-gateway-internal). Overrides the auto-detect
# from /accounts.
# export CANTON_STREAMS_SIGNING_PROVIDER=fireblocks   # or participant / blockdaemon / dfns / wallet-gateway-internal

# --asset-key reads InstrumentRef from config/asset-registry.json
# Then the probe runs:
node scripts/testnet-usdcx-stream-probe.mjs --target testnet --asset-key cc
```

The probe will:

1. Run pre-flight (verifies all env + connectivity + asset routing + gateway reachability)
2. Submit `CreateTokenStandardStreamRequest` — Wallet Gateway signs as sender
3. Recipient accepts (gateway signs) → `TokenStandardEscrow` contract created
4. Sender funds the escrow via wallet-gateway (real CC transfer)
5. Recipient withdraws (real CC transfer back to recipient)
6. Print all four `updateId`s for audit

Expected runtime: ~30–90 seconds depending on participant + asset
admin response times.

### 4.2 USDCx on TestNet

Same script, different `--asset-key`:

```bash
node scripts/testnet-usdcx-stream-probe.mjs --target testnet --asset-key usdcx
```

This populates `INSTRUMENT_ID=USDCx` + the USDCx admin/depository from
the registry. You still need a funded USDCx wallet on the test network.

### 4.3 Dry-run first, every time

```bash
node scripts/testnet-usdcx-stream-probe.mjs --target testnet --asset-key cc --dry-run
```

Dry-run hits the JSON Ledger API, verifies the JWT, decodes the
asset registry, and reports back. NO commands are submitted.

---

## 5. Mainnet (post-audit only)

After the M3 audit closes (STR-24, STR-26) and all Critical/High
findings are remediated, mainnet runs become available. The probe's
mainnet guard requires explicit acknowledgment:

```bash
I_HAVE_MAINNET_CREDENTIALS=true \
node scripts/testnet-usdcx-stream-probe.mjs --target mainnet --asset-key cc
```

Before running on mainnet:

- ✅ M3 audit report published with Critical/High closed
- ✅ Asset registry populated with real mainnet identifiers (no `TBD::`)
- ✅ Canonical template manifest published (STR-50)
- ✅ Wallet funded with enough CC/USDCx to cover the test (≥ $0.50 per lifecycle)
- ✅ Stream ID chosen to be auditable (avoid `${Date.now()}` for traceable runs)
- ✅ Operator runbook reviewed by Foundation oversight
- ✅ `I_HAVE_MAINNET_CREDENTIALS=true` set explicitly

The probe's pre-flight will refuse the run if any of these are
missing. The 1,429-line auto-withdraw worker in the proxy is NOT
involved — these are single-stream probes for verification, not
production worker runs.

---

## 6. Troubleshooting

### Pre-flight: "JSON Ledger API not reachable: ... 403"

The participant is rejecting your token. Verify:
- JWT is set in `CANTON_LEDGER_TOKEN` (or `LEDGER_TOKEN`)
- JWT is not expired (the probe will decode and warn)
- JWT audience matches the participant
- JWT has the right scopes for the parties you're using

### Pre-flight: "Package not vetted on this participant"

The canton-streams DAR isn't uploaded to that participant yet:

```bash
daml ledger upload-dar --host ... --tls --access-token-file ... \
  packages/daml/main/.daml/dist/canton-streams-0.2.8.dar
```

### Pre-flight: "Parties not visible to this participant"

The parties you specified are allocated on a different participant.
Either (a) allocate them on this one, or (b) use parties that exist here.

### Pre-flight: "Asset has placeholder values"

The `config/asset-registry.json` has `TBD::...` values for that asset.
Populate them from the SV network status page before running on
TestNet or Mainnet.

### Probe hangs at "Step 3/4: waiting Ns for full vesting…"

That's just the configured `STREAM_DURATION_SECONDS` (default 60). The
probe waits for the stream to fully vest before withdrawing.

### Probe fails at "Step 4/4: Withdraw_Stream"

Common causes:
- Recipient party doesn't have `actAs` permission via the JWT
- Stream already withdrawn (race; check for duplicate runs with same `STREAM_ID`)
- Insufficient escrow balance (only for TokenStandardCustody; check wallet)

### V2 / V1V2-mixed probes exit immediately

Those probes are scaffolded but blocked on STR-65 (real V2 DARs).
They report "V2 DARs not yet present" and exit cleanly. Once STR-65
lands, they activate automatically.

---

## 7. Acceptance gates per milestone

| Milestone | Acceptance |
|-----------|------------|
| **M1**    | `testnet-cc-stream-probe.mjs --target devnet` runs green end-to-end |
| **M2**    | `testnet-usdcx-stream-probe.mjs --target testnet --asset-key usdcx` runs green; CIP-103 conformance suite passes |
| **M3**    | All three asset paths green on TestNet via the unified probe + the V1V2Mixed conformance test on V2-DevNet; M3 audit report published |
| **M4**    | Mainnet adoption metrics gate (≥5 external parties, ≥50 streams, ≥3 settlement modes — see STR-53/54) |
| **M5**    | Cumulative CC burn ≥ 200K CC thresholds via the multi-Scan adoption metrics aggregator |

The probes from this runbook drive M1/M2/M3 acceptance directly.
M4/M5 acceptance shifts to `scripts/query-adoption-metrics.mjs`
running against the production mainnet Scan endpoints.

---

## 8. References

- `scripts/lib/preflight.mjs` — the shared pre-flight module these probes use
- `config/asset-registry.json` — per-asset routing (admin, Scan, wallet-gateway, capabilities)
- `docs/THREAT-MODEL.md` — security boundaries the probes exercise
- `docs/integration-guide/allocation-request-pattern.md` — V2 AllocationRequest pattern
- `docs/integration-guide/per-asset-config.md` — registry field reference
- `docs/OPERATIONS.md` — runbook for the production proxy + auto-withdraw worker
- `docs/DEPLOYMENT.md` — production DAR upload + manifest workflow
