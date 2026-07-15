# Host-Wallet Onboarding — Wiring a Hosted Wallet into Streams

How a wallet provider or dApp connects a user's wallet to Canton
Payment Streams: connect → identity → read → write/approval, with the
exact calls the reference dashboard makes today. This is the canonical
wallet-integration page; companion to
[`streams-integration.md`](./streams-integration.md) (server-side) and
[`cip-103-conformance.md`](./cip-103-conformance.md) (validation).

"Hosted wallet" here means the user's keys live with a wallet product
(browser wallet, mobile wallet, custodial gateway), never in the dApp.
The dApp asks the wallet to sign; the wallet drives its own approval
UI.

---

## The three integration paths

```
 ┌──────────────────────────── dashboard / your dApp ───────────────────────────┐
 │                                                                              │
 │  Path 1: dapp-sdk            Path 2: PartyLayer           Path 3: server     │
 │  (single CIP-103 wallet)     (hosted multi-wallet)        SigningProvider    │
 │        │                           │                           │             │
 ▼        ▼                           ▼                           ▼             │
 Splice Wallet Kernel          PartyLayer SDK             Wallet Gateway        │
 wallet gateway (:3030)        (Loop, Console,            JSON-RPC /api/v0/dapp │
 JSON-RPC /api/v0/dapp         Cantor8, Nightly,          per-party provider:   │
        │                      Send, Bron adapters)       participant / HSM /   │
        ▼                           │                     MPC / internal        │
 participant (JWT to dApp)          ▼                           │               │
                               wallet-proxied                   ▼               │
                               `ledgerApi` (no JWT)        participant          │
```

| Path | Module | Who signs | dApp gets a JWT? |
|---|---|---|---|
| 1. Browser CIP-103 wallet (dapp-sdk) | `packages/dashboard/src/store/wallet/dappSdkClient.ts` | User, in the wallet-gateway popup | Yes — `status().network.accessToken` |
| 2. PartyLayer adapter wallets | `packages/dashboard/src/store/wallet/partyLayerClient.ts` | User, in the wallet's own surface | No — all ledger access via `walletClient.ledgerApi` |
| 3. Server-side SigningProvider | `packages/sdk/src/signing/` | Service party, via the gateway's bound provider | Yes — gateway-issued `accessToken` |

The dashboard selects path 1 or 2 at build time via `VITE_WALLET_LAYER`
(`store/wallet/config.ts` + `store/wallet/index.ts`). Path 3 is for
backends (executors, billing crons) and has no browser dependency.

---

## Path 1 — Browser CIP-103 wallet via dapp-sdk

The standard single-wallet flow against a Splice Wallet Kernel
wallet gateway (or any CIP-103-conformant remote wallet).

```env
# packages/dashboard/.env.local
VITE_WALLET_LAYER=dapp-sdk
VITE_WALLET_GATEWAY_URL=http://localhost:3030/api/v0/dapp
VITE_SKIP_WALLET_PICKER=true     # dev only: auto-pick the remote wallet
VITE_WALLET_NAME=Splice Amulet Wallet
```

Connect lifecycle (what `store/auth.tsx` actually does):

```ts
import { walletClient } from './store/wallet/index.js';

await walletClient.init();
await walletClient.onStatusChanged(onStatus);   // re-render on session change
await walletClient.onAccountsChanged(onAccounts);

const result = await walletClient.connect();    // opens the gateway login popup
const status = await walletClient.status();     // { connection, network, provider }
const accounts = await walletClient.listAccounts();
const party = accounts.find((a) => a.primary)?.partyId ?? accounts[0]?.partyId;
const jwt = status.network?.accessToken;        // present on this path
```

With a JWT in hand, the dashboard routes reads and writes through the
REST proxy (`api/client.ts` `request()` with `Authorization: Bearer`).
The wallet also exposes `ledgerApi` and `prepareExecuteAndWait`
(capability flags in `store/wallet/types.ts`), so a dApp without a
proxy can submit wallet-signed commands directly.

Local gateway setup, allowed-origins config, and the popup caveats for
automation follow the Splice Wallet Kernel gateway's own setup docs.

### Building and submitting a stream (Path 1)

Once connected, build the stream params with an SDK use-case helper and
submit them through the wallet. `buildVestingStream` returns a
`CreateStreamParams` payload; the create exercises the streams workflow
that emits the CIP-0112 `AllocationRequest`.

```ts
import { buildVestingStream } from '@canton-streams/sdk/helpers';
import { loadAssetRegistry } from '@canton-streams/sdk';

const registry = loadAssetRegistry(assetRegistryFile);
const usdcx = registry.requireAsset('usdcx');
const usdcxInstrumentRef = {
  depository: usdcx.instrumentIdV2.admin,
  issuer: usdcx.instrumentIdV2.admin,
  instrumentId: usdcx.instrumentIdV2.id,
  instrumentVersion: usdcx.allocationsV2 ? 'v2' : 'v1',
};

const params = buildVestingStream({
  streamId: `vest-${Date.now()}`,
  sender: senderParty,
  recipient: recipientParty,
  totalAmount: '50000',
  startTime: new Date(),
  durationDays: 365 * 2,
  cliffDays: 90,
  instrumentRef: usdcxInstrumentRef,
  escrowOperator: escrowOperatorParty,
  fundingReference: walletFundingRef, // from the wallet's V2 allocation funding step
});
```

Submit via the wallet when it advertises `capabilities.prepareExecuteAndWait`;
otherwise fall back to `ledgerApi('/v2/commands/submit-and-wait')`. The
wallet renders its own approval UI and the call resolves when the user
approves and the command commits.

```ts
if (walletClient.capabilities.prepareExecuteAndWait) {
  await walletClient.prepareExecuteAndWait!({
    actAs: [party],
    commands: [/* create CreateStreamRequest carrying the StreamConfig from `params` */],
  });
}
```

Recipient-side, withdrawals are signed the same way — one
`Withdraw_Stream` exercise, signed by the recipient's wallet:

```ts
await walletClient.prepareExecuteAndWait!({
  actAs: [party],
  commands: [{
    ExerciseCommand: {
      templateId: STREAM_ESCROW_TEMPLATE_ID,
      contractId: streamCid,
      choice: 'Withdraw_Stream',
      choiceArgument: { withdrawTime: new Date().toISOString() },
    },
  }],
});
```

Hosted `submit-and-wait` returns only an update id — re-read the ACS
after every write rather than relying on a returned contract id.

## Path 2 — PartyLayer adapter wallets (hosted multi-wallet)

One picker, many wallet products (5N Loop, Console, Cantor8, Nightly,
Send; Bron needs app-specific OAuth). These wallets do **not** hand the
dApp a JWT. Everything goes through the wallet-proxied CIP-103
`ledgerApi({ requestMethod, resource, body })` round-trip that the
wallet validates and signs.

```env
VITE_WALLET_LAYER=partylayer
VITE_PARTYLAYER_NETWORK=devnet          # devnet | testnet | mainnet
VITE_PARTYLAYER_APP_NAME=Canton Payment Streams
```

Connect + identity:

```ts
const wallets = await walletClient.listWallets!();      // picker entries
await walletClient.connect('loop');                     // or QR/deep-link flow
const accounts = await walletClient.listAccounts();
// [{ primary: true, partyId: '...', signingProviderId: 'loop' }]
```

`store/auth.tsx` treats a connected hosted wallet with a party id as an
authenticated session even without a JWT (`hostedWalletAuth`), and
`api/client.ts` `isHostedWalletSession()` switches every call site from
the proxy to the wallet's ledger surface.

Reads — ACS query through the wallet (`lib/hostedWalletLedger.ts`
`queryActiveContracts`):

```ts
await walletClient.ledgerApi!({
  requestMethod: 'post',
  resource: '/v2/state/acs',
  body: JSON.stringify({
    filter: {
      filtersByParty: {
        [party]: {
          inclusive: {
            templateFilters: [
              { templateId: '#canton-streams:CantonStreams.Stream.Escrow:StreamEscrow' },
            ],
          },
        },
      },
    },
    verbose: false,
    activeAtOffset: '0',
  }),
});
```

Writes — command submission through the wallet (`submitAndWait`):

```ts
await walletClient.ledgerApi!({
  requestMethod: 'post',
  resource: '/v2/commands/submit-and-wait',
  body: JSON.stringify({
    commands: [{
      ExerciseCommand: {
        templateId: '#canton-streams:CantonStreams.Stream.Escrow:StreamEscrow',
        contractId,
        choice: 'Withdraw_Stream',
        choiceArgument: { withdrawTime: microsSinceEpochString },
      },
    }],
    commandId,                 // must be unique per submission
    actAs: [party],
    readAs: [party],
    applicationId: 'canton-streams-dashboard',
  }),
});
```

The wallet pops its signing UI for the user; the call resolves when the
command lands (or the user rejects). Quirks the adapter layer already
absorbs for you (`lib/hostedWalletLedger.ts`):

- **Template-id format**: `#<package-name>:<module>:<entity>` — the `#`
  selects the package by name. Short `module:entity` ids are rejected.
- **Filter shape**: Loop's adapter parses the v1 Daml JSON-API filter
  shape (`inclusive.templateFilters[0].templateId`), and only the first
  templateId. Generic-passthrough wallets accept the canonical v2
  `cumulative + identifierFilter` shape (see
  `lib/walletAdapters/canonicalAcs.ts`).
- **Response wrapper**: Loop returns `{ response: "<stringified json>" }`;
  other adapters return the parsed object. Handle both.
- **Opaque results**: `submit-and-wait` via the wallet returns at most
  an update/command id — no exercise result, no created contract ids.
  Re-read the ACS after a write; treat any client-side amounts as
  estimates.
- **DAR-not-vetted errors** (`PACKAGE_NAMES_NOT_FOUND`, "Failed to get
  active contracts") mean the streams DAR isn't on the participant the
  wallet talks to — render an empty state, not a crash
  (`api/client.ts` `isDarNotDeployedError`).

Holdings reads are wallet-specific because CIP-103 deliberately has no
holdings method (`lib/walletHoldings.ts` dispatches): Loop has its own
REST endpoint (`lib/loopWallet.ts`); Send/Nightly/Console accept a
canonical ACS query for the CIP-56 `HoldingV2` interface
(`lib/walletAdapters/canonicalAcs.ts`, needs the Splice token-standard
V2 DARs vetted); Cantor8 and Bron expose no browser read API — the
facade returns `{ strategy: 'unsupported', reason }` for honest UI copy.

## Path 3 — Server-side wallet-gateway SigningProvider

For backends that act as a service party (stream creation cron,
auto-withdraw executor). Keys live behind the Wallet Gateway's bound
signing provider — `participant` (production default),
`fireblocks`, `blockdaemon`, `dfns`, or `wallet-gateway-internal`
(dev/test only). The provider is bound per-party at wallet creation;
the SDK discovers it from `listAccounts()` and routes per party.

```ts
import { createSigning, createSigningFromEnv } from '@canton-streams/sdk';

// Explicit config…
const { resolver } = await createSigning({
  gatewayUrl: 'https://gateway.example/api/v0/dapp',
  accessToken: gatewayJwt,                     // from the gateway connect()
});
// …or from env (CANTON_STREAMS_WALLET_GATEWAY_URL + _TOKEN):
// const { resolver } = await createSigningFromEnv();

const signer = await resolver.forParty(senderParty);
await signer.prepareExecuteAndWait({ /* Daml command, CIP-103 shape */ });
const holdings = await signer.ledgerApi({ /* ACS query */ });
```

See `packages/sdk/src/signing/provider.ts` (interface + error codes),
`resolver.ts` (per-party routing), and `adapters/` (the five provider
kinds). Provider credentials (HSM/MPC API keys) are configured on the
gateway, never in your process.

---

## The approval UX — what the user actually signs

1. **Create** (sender): the wallet shows one transaction — `create
   CreateStreamRequest` carrying the full `StreamConfig` (recipient,
   total, start/end, vesting curve, cancellable flag). One signature.
2. **Accept** (recipient): one `AcceptStream` exercise. The escrow
   contract is created with both parties as signatories.
3. **Lifecycle** (withdraw / cancel / renew): one exercise each, signed
   by the controlling party only (recipient withdraws; sender cancels
   or renews). Mutual cancel needs both signatures — see limitations.
4. **Funding / settlement** (TokenStandardCustody streams): the
   asset-leg approval is rendered by the wallet's own token-standard
   UX (V2 AllocationRequest acceptance), not by the dashboard. The
   Inbox's approval control (`components/streams/WalletApprovalControl.tsx`
   + `lib/walletApprovals.ts`) opens/points to the wallet and records a
   local confirmation — it cannot observe the wallet-internal approval.

### TransferPreapproval — hands-free receiving

For CC settlement legs, a recipient who holds a Splice
`TransferPreapproval` contract receives each settlement in **one step**
(`TransferPreapproval_SendV2`, transfer kind `direct`) — no per-cycle
acceptance. Without it, every cycle creates a two-step offer the
recipient must accept in their wallet (works, worse UX). Onboarding
recommendation: have recipients create a TransferPreapproval **once**
in their wallet (most Canton wallets and the validator wallet UI offer
this). Verified live on MainNet.

---

## Capability matrix

Per action, per path, as implemented in this repo. "auto" = works with
no manual step beyond the wallet's signing prompt; "manual" = works but
needs a user step outside the dApp; "—" = not supported on that path.

| Action | dapp-sdk (CIP-103 browser) | PartyLayer hosted wallets | Server SigningProvider |
|---|---|---|---|
| Connect + identity | auto — `dappSdkClient.connect()` → `listAccounts()` | auto — `partyLayerClient.connect()` → session party (`store/auth.tsx`) | auto — gateway token + `resolver.forParty()` (`sdk/signing/resolver.ts`) |
| Read holdings | — in dashboard (gateway UI owns balances; `useWalletHoldings` is PartyLayer-only) | auto — Loop REST / canonical ACS; Cantor8 + Bron: — with reason (`lib/walletHoldings.ts`) | auto — `signer.ledgerApi()` ACS query (no packaged helper) |
| Read streams + pending requests | auto — REST proxy with wallet JWT (`api/client.ts`) | auto — wallet ACS + decoders (`listStreams`, `listPendingStreamRequests`, `getStream`) | auto — SDK query commands |
| Read stream history / execution logs | auto — proxy routes | — returns `[]` (no `/v2/updates` decoder yet) | auto — proxy/SDK |
| Create stream | auto — proxy `POST /api/streams` | auto — `CreateCommand` via `submitAndWait` (`createStream`) | auto — `prepareExecuteAndWait` |
| Accept stream | auto — proxy accept route | auto — `AcceptStream` exercise (`acceptStream`) | auto |
| Withdraw | auto — proxy | auto — `Withdraw_Stream` exercise; returned amounts are client-side estimates | auto |
| Cancel (unilateral) | auto — proxy | auto — `Cancel_Stream` exercise | auto |
| Mutual cancel | auto — proxy (operator orchestrates) | — needs sender + recipient signatures | auto when gateway hosts both parties |
| Top-up / renew | auto — proxy | auto — `Renew_Stream` exercise (`renew`) | auto |
| Policy revoke | auto — proxy | auto — `RevokePolicy` exercise (`revokePolicy`) | auto |
| Token-standard funding approval | manual — wallet's V2 allocation UX | manual — wallet's V2 allocation UX | auto — service party drives allocation |
| TransferPreapproval setup | manual — once, in recipient's wallet | manual — once, in recipient's wallet | manual — once, by recipient |

## Known limitations (hosted-wallet path)

- **Mutual cancel** — the Daml choice is controlled by sender AND
  recipient; a wallet session signs for one party. Route via an
  operator/proxy, or use unilateral cancel on `cancellable` streams.
- **Exercise results are opaque** — hosted wallets return only an
  update id from `submit-and-wait`. The dashboard reports client-side
  accrual estimates after withdraw/cancel and refetches the ACS; the
  ledger is authoritative.
- **History + execution logs read as empty** — decoding the update
  stream through the wallet surface isn't built; lists return `[]`.
- **Loop filter allowlist** — only v1-shaped, single-template ACS
  filters pass Loop's adapter; multi-template reads are issued as
  separate queries.
- **Holdings on signing-only wallets** — Cantor8 (sign-only adapter)
  and Bron (OAuth-only) cannot list balances browser-side; the UI shows
  the reason string instead.

## Env/config reference

| Variable | Path | Default | Meaning |
|---|---|---|---|
| `VITE_WALLET_LAYER` | 1/2 | `dapp-sdk` | `dapp-sdk` or `partylayer` |
| `VITE_WALLET_GATEWAY_URL` | 1 | `http://localhost:3030/api/v0/dapp` | CIP-103 endpoint of the wallet gateway |
| `VITE_SKIP_WALLET_PICKER` | 1 | `false` | Auto-select the remote gateway adapter (dev) |
| `VITE_WALLET_NAME` | 1 | `Splice Amulet Wallet` | Display name for the remote adapter |
| `VITE_PARTYLAYER_NETWORK` | 2 | `devnet` | Network passed to the PartyLayer SDK |
| `VITE_PARTYLAYER_APP_NAME` | 2 | `Canton Payment Streams` | dApp name shown in wallet consent |
| `CANTON_STREAMS_WALLET_GATEWAY_URL` | 3 | — | Gateway dApp API URL for `createSigningFromEnv()` |
| `CANTON_STREAMS_WALLET_GATEWAY_TOKEN` | 3 | — | Gateway-issued JWT for the same |

On-ledger prerequisite for every path: the `canton-streams` DAR must be
vetted on the participant the wallet/gateway talks to (plus the Splice
token-standard V2 DARs for holdings reads and token-standard funding).
Until then, reads come back empty and creates fail with a
package-not-found error the dashboard maps to an actionable message.

## Onboarding checklist for a new wallet product

1. **CIP-103 surface** — confirm the wallet exposes `connect`,
   `status`, `listAccounts`, and `ledgerApi` (ACS + submit-and-wait at
   minimum). If it implements `prepareExecuteAndWait`, flag it in
   `WalletCapabilities` (`store/wallet/types.ts`).
2. **PartyLayer adapter** — if the wallet ships a PartyLayer adapter,
   it appears in `listWallets()` automatically; no dashboard change
   needed for connect/identity.
3. **Filter dialect** — test whether its `ledgerApi` passes the
   canonical v2 ACS filter or only the v1 shape; reuse
   `canonicalAcs.ts` or the Loop-shaped body accordingly.
4. **Holdings strategy** — add a case to `pickStrategy()` in
   `lib/walletHoldings.ts`: own REST module (like `loopWallet.ts`),
   `canonical-acs`, or `unsupported` with a user-facing reason.
5. **Write path** — run one `submitAndWait` create + exercise round
   trip; verify the wallet renders the command, the template-id format
   it expects, and what (if anything) it returns.
6. **Token-standard UX** — verify the wallet renders V2
   AllocationRequest / transfer-offer approvals; that is the funding
   leg for TokenStandardCustody streams.
7. **Preapproval story** — document how a user creates a
   TransferPreapproval in the wallet so recipients can onboard
   hands-free.

## Production checklist

- [ ] CIP-103 OpenRPC conformance suite passes (see [`cip-103-conformance.md`](./cip-103-conformance.md))
- [ ] Asset registry includes the production InstrumentRef + Scan endpoint for every asset you accept
- [ ] You subscribe to `onAccountsChanged` so the UI re-binds when the user switches accounts
- [ ] You handle `onStatusChanged → disconnected` by prompting reconnect, not by silently failing
- [ ] You don't store JWT bearer tokens in localStorage (the wallet handles signing; the JWT is only for proxy / Ledger-API reads)
- [ ] You re-read the ACS after every wallet-submitted write (hosted `submit-and-wait` returns only an update id)
- [ ] Featured-app marker emission is reviewed against the current CIP-0047/CIP-0104 regime before enabling it
