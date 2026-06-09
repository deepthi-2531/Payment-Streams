# TestNet Runbook

This runbook is for operators who want to exercise Canton Payment Streams
against a real DevNet or TestNet participant. Do not use these probes on
mainnet unless you have reviewed the deployment, wallet, and asset risk with
your own operators.

## What The Probes Cover

| Probe | Asset path | Purpose |
| --- | --- | --- |
| `scripts/testnet-token-standard-stream-probe.mjs` | Registered V2 token-standard asset | Production-shaped V2 stream smoke. |
| `scripts/testnet-v2-stream-probe.mjs` | V2-native asset | V2 allocation and settlement verification. |
| `scripts/testnet-cc-stream-probe.mjs` | CC sandbox fixture | Historical sandbox smoke, not production acceptance. |
| `scripts/testnet-usdcx-stream-probe.mjs` | Configured CC/USDCx asset | Wallet-gateway-backed transfer probe. |

The production path is V2-only. Legacy probes remain as migration and smoke
tools, not as evidence that a production wallet flow is ready.

## Preflight

Every probe should be run with `--dry-run` first:

```bash
node scripts/testnet-usdcx-stream-probe.mjs --dry-run --target testnet --asset-key cc
```

Preflight checks:

- JSON Ledger API connectivity.
- JWT presence, expiry, and party permissions.
- Canton Streams package visibility.
- Sender, recipient, and service parties.
- Asset registry routing.
- Wallet gateway reachability when the probe needs signing.
- Mainnet guardrails.

Fix all preflight failures before submitting ledger commands.

## Required Environment

You need:

- A Canton participant JSON Ledger API endpoint.
- The canton-streams DAR uploaded and vetted on that participant.
- A JWT with the required party permissions.
- Sender and receiver parties visible to the participant.
- A funded wallet for the asset under test.
- A populated `config/asset-registry.json` entry for the asset.
- A CIP-103 wallet gateway when the probe needs wallet signing.

Example:

```bash
export CANTON_JSON_API_URL=https://testnet.example.com:7575
export CANTON_LEDGER_TOKEN=$TESTNET_TOKEN
export CANTON_STREAMS_PACKAGE_ID=<package-id>
export SENDER_PARTY=sender::participant
export RECIPIENT_PARTY=recipient::participant
export CANTON_STREAMS_WALLET_GATEWAY_URL=https://wallet.example.com/api/v0/dapp
export CANTON_STREAMS_WALLET_GATEWAY_TOKEN=$WALLET_GATEWAY_SESSION_TOKEN
```

## DAR Upload

Build and upload the Daml packages:

```bash
daml build --project-root packages/daml/main
daml build --project-root packages/daml/interfaces

daml ledger upload-dar \
  --host <participant-host> \
  --port 5001 \
  --tls \
  --access-token-file <token-file> \
  packages/daml/main/.daml/dist/canton-streams-0.2.8.dar
```

Then build the template manifest:

```bash
node scripts/build-template-manifest.mjs
```

## Running A Probe

```bash
pnpm --filter @canton-streams/sdk build
node scripts/testnet-usdcx-stream-probe.mjs --target testnet --asset-key cc
```

Expected shape:

```text
========================================
 Canton Coin Stream Lifecycle Probe
 Token Standard verification
========================================

Pre-flight
  packageVetted: true
  pre-flight passed

Step 1: create stream request
Step 2: wallet-mediated approval
Step 3: settlement / withdrawal
Final state: completed
```

If a probe reports `pre-flight FAILED`, stop and fix the listed issue.

## Mainnet Guardrails

Mainnet probes require explicit acknowledgement:

```bash
I_HAVE_MAINNET_CREDENTIALS=true \
node scripts/testnet-usdcx-stream-probe.mjs --target mainnet --asset-key cc
```

Before doing this, confirm:

- The asset registry has real mainnet identifiers and no `TBD::` values.
- The wallet has enough funds for the full lifecycle.
- The stream id is auditable and not a throwaway timestamp.
- Operators have reviewed the exact command, asset, parties, and amount.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| JSON Ledger API returns 403 | JWT scope or audience is wrong | Regenerate the token with correct party permissions. |
| Package not vetted | DAR is missing on the participant | Upload and vet the canton-streams DAR. |
| Party not visible | Party belongs to another participant | Allocate or use a party visible to this participant. |
| Asset has placeholders | Registry entry is incomplete | Fill in admin party, instrument id, scan endpoint, and wallet gateway. |
| Wallet signing fails | Gateway session is invalid or expired | Reconnect the wallet and refresh the session token. |
| Probe hangs during accrual | Stream duration is still elapsing | Wait or shorten the configured duration for smoke tests. |

## References

- `scripts/lib/preflight.mjs`
- `config/asset-registry.json`
- `scripts/build-template-manifest.mjs`
- `docs/THREAT-MODEL.md`
- `docs/E2E-HARNESS.md`
