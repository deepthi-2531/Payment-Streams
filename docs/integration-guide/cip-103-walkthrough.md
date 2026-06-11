# CIP-103 Walkthrough — Browser-Wallet Stream Integration

End-to-end walkthrough of integrating Canton Payment Streams into a
browser-side dApp using CIP-103 wallet signing (Path A).

This is the canonical recipient-side flow: the user holds their own
keys in a CIP-103-compliant wallet (Splice Wallet Kernel or
equivalent); your dApp never sees private keys; the wallet signs and
submits everything.

> **Where the wallet integration actually lives.** Canton Payment
> Streams does not ship a standalone CIP-103 provider class in the SDK.
> The working browser-wallet integration is the **dapp wallet provider**
> used by the reference dashboard — `walletClient` in
> [`packages/dashboard/src/store/wallet/`](../../packages/dashboard/src/store/wallet)
> (the `dapp-sdk` path wraps a Splice Wallet Kernel gateway; the
> `partylayer` path wraps hosted multi-wallets). This walkthrough shows
> the CIP-103 lifecycle against that real surface. For the full
> capability matrix, env wiring, and the exact calls the dashboard
> makes, see [`host-wallet-onboarding.md`](./host-wallet-onboarding.md).

---

## Pre-requisites

- A CIP-103-conformant wallet available to the user (Splice Wallet
  Kernel or any wallet implementing the OpenRPC contract published in
  `splice-wallet-kernel`)
- The Canton Payment Streams SDK installed: `npm i @canton-streams/sdk`
- The reference dashboard's wallet provider (`store/wallet`) wired into
  your app, or your own client implementing the same
  `StreamsWalletClient` surface (`store/wallet/types.ts`)
- A copy of the canonical `asset-registry.json` for your network
  (commit it in your repo, or fetch it at runtime)

---

## The CIP-103 lifecycle on the real provider

The provider exposes the standard connect → identity → prepareExecute →
events lifecycle. The method names below are the `StreamsWalletClient`
surface (`packages/dashboard/src/store/wallet/types.ts`), which the
`dapp-sdk` and `partylayer` clients both implement.

## Step 1 — Set up the provider and subscribe to lifecycle events

```ts
import { walletClient } from './store/wallet/index.js';

await walletClient.init();

// Subscribe to lifecycle events to drive UI state.
await walletClient.onAccountsChanged((accounts) => updatePartyChip(accounts));
await walletClient.onStatusChanged((status) => updateConnectionBadge(status));
```

## Step 2 — Connect to the wallet (identity)

```ts
const result = await walletClient.connect(); // opens the gateway login popup
const status = await walletClient.status();  // { connection, network, provider }

if (status.connection.isConnected) {
  const accounts = await walletClient.listAccounts();
  const primary = accounts.find((a) => a.primary) ?? accounts[0];
  setSessionParty(primary?.partyId);
}
```

On the `dapp-sdk` path, `status.network?.accessToken` carries a JWT the
dApp can use to talk to a REST proxy or the Ledger API directly. The
`partylayer` (hosted multi-wallet) path returns no JWT — every ledger
call goes back through the wallet's `ledgerApi`. See
[`host-wallet-onboarding.md`](./host-wallet-onboarding.md) for both.

## Step 3 — Build the params (use case helper)

```ts
import { buildVestingStream } from '@canton-streams/sdk/helpers';
import { loadAssetRegistry } from '@canton-streams/sdk';

const registry = loadAssetRegistry(assetRegistryFile);
const usdcx = registry.requireAsset('usdcx');

const params = buildVestingStream({
  streamId: `vest-${Date.now()}`,
  sender: senderParty,
  recipient: recipientParty,
  totalAmount: '50000',
  startTime: new Date(),
  durationDays: 365 * 2,
  cliffDays: 90,
  instrumentRef: usdcx.instrumentRef!,
  escrowOperator: escrowOperatorParty,
  fundingReference: walletFundingRef, // from the wallet's V2 allocation funding step
});
```

`buildVestingStream` returns a `CreateStreamParams` payload. To submit
it browser-side, feed it through `CantonStreamsClient.createStream`
(when you have a wallet-issued JWT and a transport) or build the
wallet command directly and submit it with `prepareExecuteAndWait` /
`ledgerApi` as shown next.

## Step 4 — Submit via the wallet (`prepareExecuteAndWait`)

When the wallet advertises `capabilities.prepareExecuteAndWait`, submit
a Daml command and wait for it to land in one call. The create exercises
the streams workflow that emits the CIP-0112 `AllocationRequest`:

```ts
if (walletClient.capabilities.prepareExecuteAndWait) {
  const result = await walletClient.prepareExecuteAndWait!({
    actAs: [primary.partyId],
    commands: [/* create CreateStreamRequest carrying the StreamConfig from `params` */],
  });
  trackPending(result);
} else {
  // Hosted wallets without prepareExecuteAndWait submit via ledgerApi
  // (`/v2/commands/submit-and-wait`) — see host-wallet-onboarding.md.
}
```

The wallet renders its own approval UI; the call resolves when the user
approves and the command commits (or rejects). Hosted-wallet
`submit-and-wait` returns at most an update id — re-read the ACS after a
write rather than relying on a returned contract id.

## Step 5 — Drive UI from the lifecycle events

The connect-time `onStatusChanged` / `onAccountsChanged` subscriptions
are the lifecycle signal: re-render the party chip when accounts change,
and prompt reconnect when the session disconnects.

```ts
await walletClient.onStatusChanged((status) => {
  if (!status.connection.isConnected) showReconnectPrompt();
  else reloadStreams();
});
```

## Step 6 — Read state via `ledgerApi`

When the wallet advertises `capabilities.ledgerApi`, query the ACS
through the wallet's proxied Ledger API:

```ts
const streams = await walletClient.ledgerApi!({
  requestMethod: 'post',
  resource: '/v2/state/acs',
  body: JSON.stringify({
    filter: {
      filtersByParty: {
        [primary.partyId]: {
          inclusive: {
            templateFilters: [{ templateId: STREAM_ESCROW_TEMPLATE_ID }],
          },
        },
      },
    },
    verbose: false,
    activeAtOffset: '0',
  }),
});
```

The exact filter dialect and response wrapper vary by wallet — the
dashboard's `lib/hostedWalletLedger.ts` absorbs those quirks. On the
`dapp-sdk` path with a JWT, the dApp can instead talk to a REST proxy or
the Ledger API directly with `status.network?.accessToken`.

---

## Recipient-side actions

Once the stream is active, the recipient signs their own withdrawals
through the same submit surface:

```ts
await walletClient.prepareExecuteAndWait!({
  actAs: [primary.partyId],
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

The wallet prompts the user; on approval, the withdrawal is signed by
the recipient's wallet directly. Hosted wallets that lack
`prepareExecuteAndWait` submit the same exercise via
`ledgerApi('/v2/commands/submit-and-wait')`.

---

## Error handling

Treat a rejected approval and a dropped session as the two cases your UI
must handle. A user who declines the wallet prompt surfaces as a
rejection from `prepareExecuteAndWait` / `ledgerApi`; a dropped session
surfaces through `onStatusChanged` with `connection.isConnected ===
false`.

```ts
try {
  await walletClient.prepareExecuteAndWait!(req);
} catch (err) {
  // User declined in the wallet, or the session dropped mid-submit.
  showToast('Wallet action did not complete — check the wallet and retry');
}

await walletClient.onStatusChanged((status) => {
  if (!status.connection.isConnected) showReconnectPrompt();
});
```

---

## Production checklist

- [ ] CIP-103 OpenRPC conformance suite passes (see `cip-103-conformance.md`)
- [ ] Asset registry includes the production InstrumentRef + Scan endpoint for every asset you accept
- [ ] You subscribe to `onAccountsChanged` so the UI re-binds when the user switches accounts
- [ ] You handle `onStatusChanged → disconnected` by prompting reconnect, not by silently failing
- [ ] You don't store JWT bearer tokens in localStorage (the wallet handles signing; Path A only needs the JWT for proxy/Ledger-API reads)
- [ ] You re-read the ACS after every wallet-submitted write (hosted `submit-and-wait` returns only an update id)
- [ ] Featured-app marker emission is reviewed against the current CIP-0047/CIP-0104 regime before enabling it
