# Amulet Wallet / Splice Wallet Kernel — Local Signup / Sign-In Runbook

Companion to `TESTNET-RUNBOOK.md`. Covers wiring the dashboard's
`@canton-network/dapp-sdk` to a local Amulet wallet gateway for the
CIP-103 wallet flow (signup → sign-in → list accounts → prepareExecute).

For Token Standard V2 stream testing, prefer the Amulet wallet that runs
on a Splice validator LocalNet with Token Standard V2 support. Issue
[`canton-network/splice#5498`](https://github.com/canton-network/splice/issues/5498)
tracks the iterated-settlement Amulet wallet support this repo relies on.

---

## Architecture (what talks to what)

```
   Dashboard (:3000)
    │
    │ JSON-RPC 2.0 over HTTP+CORS
    │ method: connect / status / listAccounts / prepareExecute / signMessage / …
    ▼
   Amulet Wallet Gateway (:3030)   <— CIP-103 dapp endpoint at /api/v0/dapp
    │                              <— user UI at /login/, /parties/, /activities/
    │
    ├── Identity Providers (IDPs)
    │     • Mock OAuth (:8889)              — authorization_code / client_credentials
    │     • External OAuth provider         — production identity
    │     • self-signed unsafe-auth         — purely local dev
    │
    └── Networks (per SWK config)
          • canton:local-oauth              — bundled Canton sandbox
          • canton:local-self-signed        — same
          • canton:devnet                   — shared devnet via JSON-API
          • canton:localnet                 — `daml start` against the local SDK
```

The SDK auto-discovers the wallet gateway at the hardcoded default
`http://localhost:3030/api/v0/dapp` (set in
`@canton-network/dapp-sdk/dist/index.js`). To point at a different URL,
set `VITE_WALLET_GATEWAY_URL` in `packages/dashboard/.env.local`.

---

## Prerequisites

1. Splice LocalNet running with the validator Amulet wallet enabled. The older standalone
   SWK run process is still useful for CIP-103 smoke tests, but it is
   not the target for Token Standard V2 iterated-settlement E2E.

2. Ports we depend on:

   |      Port | Service                      | Role for our dashboard                    |
   | --------: | ---------------------------- | ----------------------------------------- |
   |      3030 | Amulet wallet gateway        | CIP-103 endpoint + user UI                |
   |      8889 | mock-oauth2-server           | OAuth IDP for local network               |
   | 5001…5202 | bundled Canton sandbox       | participant for `canton:local-*` networks |
   |      8080 | wallet-gateway-extension dev | extension preview (unused by us)          |

   Verify with `lsof -nP -iTCP -sTCP:LISTEN`.

3. SWK config must allow our dashboard origin. Edit the wallet-gateway
   config (typically `wallet-gateway/test/config.json`) so
   `server.allowedOrigins` includes the URL your dashboard runs on:

   ```json
   "allowedOrigins": ["http://localhost:8080", "http://localhost:3000"]
   ```

   Restart the wallet-gateway after editing.

4. Our proxy + dashboard running (`pnpm --filter @canton-streams/proxy
dev` and `pnpm --filter @canton-streams/dashboard dev`) per
   `TESTNET-RUNBOOK.md`.

---

## What happens when the user clicks "Connect wallet"

1. `auth.connect()` → `dappSDK.connect()` (see
   `packages/dashboard/src/store/auth.tsx`).
2. SDK fires `pickWallet()` from
   `@canton-network/core-wallet-ui-components` — a Lit-based wallet
   picker. The picker offers the user the choice of:
   - `InjectedAdapter` (`window.canton` from a browser extension)
   - `RemoteAdapter` (the wallet gateway at :3030)
   - `WalletConnectAdapter` (only if `VITE_WC_PROJECT_ID` is set)
3. When the user picks the remote adapter, the SDK opens
   `http://localhost:3030/login/` in a **popup window** (`window.open`).
4. The popup walks through the wallet gateway's network picker → IDP
   sign-in → on success it sends the dapp the session via postMessage
   to the opener.
5. SDK transitions to `isConnected: true`; the dashboard re-renders the
   authenticated layout.

### Skipping the picker (dev convenience)

Set `VITE_SKIP_WALLET_PICKER=true` in `packages/dashboard/.env.local`
to have `auth.tsx` create a dedicated `DappSDK({ walletPicker })`
instance that auto-selects the configured remote Amulet wallet. Useful
when only one wallet is available locally and the picker UI is noise.

```env
# packages/dashboard/.env.local
VITE_SKIP_WALLET_PICKER=true
VITE_WALLET_GATEWAY_URL=http://localhost:3030/api/v0/dapp
VITE_WALLET_NAME=Splice Amulet Wallet (LocalNet V2)
```

The flag is off by default and never read in production builds.

---

## End-to-end smoke test

```text
1. Verify all services are up:
     lsof -nP -iTCP:3030 -sTCP:LISTEN    # SWK
     lsof -nP -iTCP:3000 -sTCP:LISTEN    # dashboard
     lsof -nP -iTCP:8889 -sTCP:LISTEN    # mock OAuth IDP

2. Confirm SWK answers JSON-RPC from our origin:
     curl -X POST http://127.0.0.1:3030/api/v0/dapp \
       -H 'Origin: http://localhost:3000' \
       -H 'content-type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"status","params":{}}'
     # → { isConnected: false, isNetworkConnected: false,
     #     userUrl: http://localhost:3030/login/ }

   The response MUST include `Access-Control-Allow-Origin:
   http://localhost:3000` — if it doesn't, the SWK config
   `server.allowedOrigins` is missing that origin. Add it and restart.

3. Open the dashboard at http://localhost:3000/ in a normal browser.

4. Click "Connect wallet" on the landing page.

5. Wallet picker pops up → choose the remote wallet (SWK).
   (If VITE_SKIP_WALLET_PICKER=true, this step is automatic.)

6. Wallet-gateway login window opens → pick a network → click `Connect`.

7. IDP signs you in transparently for the local network, or shows a
   sign-in form for the OAuth provider.

8. Wallet-gateway shows the Parties page with your party hint and
   signing provider. Popup auto-closes; dashboard transitions to the
   authenticated layout.

9. listAccounts on the dashboard now returns your party. prepareExecute
   round-trips through the SDK → SWK → ledger.
```

---

## Headless-browser caveat

Two distinct behaviors to be aware of when driving this via a headless
browser (Playwright, Selenium, etc.):

1. **`window.open` from a JS-eval context returns `null`** in most
   automation harnesses. The browser doesn't treat tool-injected JS as
   a "user gesture", so any programmatic popup attempt is silently
   blocked.

2. **`window.open` from a synthesized click DOES open the popup — but
   in a window that may be outside the automation tab tracker.** When
   a harness's click event fires on the dashboard's "Connect wallet"
   button, the SDK's `pickWallet()` opens a popup at
   `blob:http://localhost:3000/<uuid>`. That popup is a real browser
   tab in the user's session; some automation harnesses do NOT list it
   alongside the tabs they spawned. You'll need to query the browser
   at the OS / CDP level to find and drive it.

Neither is a bug in the dashboard or in SWK. Both layers are correctly
wired; we proved at the JSON-RPC level that:

- `POST /api/v0/dapp connect` returns `userUrl`
- `POST /api/v0/dapp listAccounts` returns the CIP-103-spec
  `4100 UNAUTHORIZED` code until the dapp completes the popup flow
- Manually visiting `/login/` in a second tab authenticates the
  wallet-gateway user session against the IDP and renders the Parties
  UI

For CI without a real browser, use the SWK conformance suite (STR-13)
in `packages/sdk/src/cip103/*.test.ts` — it exercises the JSON-RPC
contract directly without any popup.

For headless flows that _do_ need to drive the picker, prefer the
`VITE_SKIP_WALLET_PICKER=true` mode described above; it removes the
popup entirely.

---

## Cross-references

- `docs/TESTNET-RUNBOOK.md` — how to bring up our proxy + dashboard
  against a remote validator
- `docs/integration-guide/cip-103-walkthrough.md` — protocol-level
  walkthrough of the dapp-sdk surface
- `packages/dashboard/src/store/auth.tsx` — the actual integration
- `packages/dashboard/src/components/wallet/ConnectFlow.tsx` — the
  Connect button + dev-mode fallback
- Upstream SWK monorepo — IDP + network bootstrap, OpenRPC spec
- SWK examples directory (`examples/ping`, `examples/portfolio`) —
  reference integrations we modeled `auth.tsx` on
