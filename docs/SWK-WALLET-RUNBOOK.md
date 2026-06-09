# Amulet Wallet Gateway Runbook

This runbook explains how the dashboard connects to a CIP-103 wallet gateway
for local and testnet development. The reference local wallet is the Splice
Amulet wallet running on a validator LocalNet.

## Architecture

```text
Dashboard
  |
  | JSON-RPC 2.0 over HTTP
  | connect / status / listAccounts / prepareExecute
  v
CIP-103 wallet gateway
  |
  | signer and account management
  v
Canton participant
```

The dashboard reads the gateway URL from `VITE_WALLET_GATEWAY_URL`. The
default local endpoint is:

```text
http://localhost:3030/api/v0/dapp
```

## Prerequisites

- Splice LocalNet running with an Amulet wallet available.
- A CIP-103 wallet gateway connected to the participant you want to test.
- Dashboard origin allowlisted by the gateway, usually
  `http://localhost:3000` and `http://127.0.0.1:3000`.
- Proxy and dashboard running.

## Dashboard Configuration

```env
VITE_WALLET_LAYER=dapp-sdk
VITE_WALLET_GATEWAY_URL=http://localhost:3030/api/v0/dapp
VITE_SKIP_WALLET_PICKER=true
VITE_WALLET_NAME=Splice Amulet Wallet
```

`VITE_SKIP_WALLET_PICKER=true` auto-selects the configured remote wallet.
Leave it unset when you want the user to choose from all available wallet
adapters.

## Smoke Test

Probe the gateway from the dashboard origin:

```bash
curl -X POST http://127.0.0.1:3030/api/v0/dapp \
  -H 'Origin: http://localhost:3000' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"status","params":{}}'
```

The response should include a valid JSON-RPC body and the expected CORS
headers. If CORS fails, add the dashboard origin to the gateway allowlist and
restart the gateway.

## Dashboard Flow

1. User clicks Connect wallet.
2. The dashboard probes `status` on the configured gateway.
3. The wallet connection returns available accounts.
4. The dashboard stores the selected party and uses it for stream commands.
5. Approval and signing happen in the wallet, not in the dashboard.

If the gateway is unavailable, the dashboard fails closed with a clear inline
error and does not open a popup fallback.

## Headless Browser Notes

Wallet popups are difficult to drive in CI because browsers often block
programmatic `window.open` calls that are not direct user gestures. For
headless runs, prefer:

- `VITE_SKIP_WALLET_PICKER=true`
- A reachable remote wallet gateway
- Contract-level tests for JSON-RPC behavior
- LocalNet E2E only when a real browser session is available

## Cross References

- `docs/E2E-HARNESS.md`
- `docs/HOSTED-WALLET-PLAN.md`
- `docs/integration-guide/cip-103-walkthrough.md`
- `packages/dashboard/src/store/auth.tsx`
- `packages/dashboard/src/store/wallet/dappSdkClient.ts`
