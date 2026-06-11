# CIP-103 Walkthrough — Browser-Wallet Stream Integration

End-to-end walkthrough of integrating Canton Payment Streams into a
browser-side dApp using CIP-103 wallet signing (Path A).

This is the canonical recipient-side flow: the user holds their own
keys in a CIP-103-compliant wallet (Splice Wallet Kernel or
equivalent); your dApp never sees private keys; the wallet signs and
submits everything.

---

## Pre-requisites

- A CIP-103-conformant wallet available to the user (Splice Wallet
  Kernel or any wallet implementing the OpenRPC contract published in
  `splice-wallet-kernel`)
- The Canton Payment Streams SDK installed: `npm i @canton-streams/sdk`
- A copy of the canonical `asset-registry.json` for your network
  (commit it in your repo, or fetch it at runtime)

---

## Step 1 — Set up the Provider

```ts
import { CIP103Provider } from '@canton-streams/sdk/cip103';
import { detectSyncWallet } from '@canton-streams/sdk/cip103/transports/sync';

// Probe for a window-injected wallet (browser extension).
// For async wallets (remote), use detectAsyncWallet({ endpoint, ... }).
const transport = await detectSyncWallet();
const provider = new CIP103Provider(transport);

// Subscribe to lifecycle events to drive UI state.
provider.on('accountsChanged', (accounts) => updatePartyChip(accounts));
provider.on('statusChanged', (status) => updateConnectionBadge(status));
provider.on('txChanged', (event) => updateTxRow(event));
```

## Step 2 — Connect to the wallet

```ts
const result = await provider.connect();

if (result.userUrl) {
  // Async wallet: send the user to this URL to complete authorization.
  window.open(result.userUrl, '_blank');
} else if (result.isConnected) {
  // Sync wallet: connection established.
  const primary = await provider.getPrimaryAccount();
  setSessionParty(primary?.party);
}
```

## Step 3 — Build the params (use case helper)

```ts
import { buildVestingStream, buildIncentiveStream } from '@canton-streams/sdk/helpers';
import { loadAssetRegistry } from '@canton-streams/sdk/assets/registry';

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

## Step 4 — Submit via the wallet

```ts
import { paramsToPrepareExecuteRequest } from '@canton-streams/sdk/cip103';

const result = await provider.prepareExecute(
  paramsToPrepareExecuteRequest(params, primary.party)
);

if (result.userUrl) {
  // Async wallet: user must approve via the userUrl.
  window.open(result.userUrl, '_blank');
} else if (result.txId) {
  // Sync wallet: submitted; lifecycle will arrive via txChanged.
  trackPendingTx(result.txId);
}
```

## Step 5 — Listen for the tx lifecycle

```ts
provider.on('txChanged', (event) => {
  switch (event.status) {
    case 'pending':
      console.log('Pending in wallet:', event.txId);
      break;
    case 'signed':
      console.log('Signed:', event.signature?.party);
      break;
    case 'executed':
      console.log('Executed:', event.execution?.updateId);
      reloadStreams();
      break;
    case 'failed':
      console.error('Failed:', event.failure?.message);
      break;
  }
});
```

## Step 6 — Read state via `ledgerApi` proxy

```ts
const streams = await provider.ledgerApi({
  requestMethod: 'post',
  resource: '/v2/state/active-contracts',
  body: {
    filter: {
      filtersByParty: {
        [primary.party]: {
          cumulative: [{
            identifierFilter: {
              TemplateFilter: {
                value: { templateId: STREAM_ESCROW_TEMPLATE_ID, includeCreatedEventBlob: false }
              }
            }
          }]
        }
      }
    },
    verbose: false,
    activeAtOffset: ledgerEnd,
  }
});
```

Many wallets allow the dApp to talk to the Ledger API directly with a
wallet-issued access token instead of proxying through the wallet —
check `provider.getNetwork().ledgerApi` and `accessToken`.

---

## Recipient-side actions

Once the stream is active, the recipient signs their own withdrawals:

```ts
await provider.prepareExecute({
  actAs: [primary.party],
  commands: [{
    ExerciseCommand: {
      templateId: STREAM_ESCROW_TEMPLATE_ID,
      contractId: streamCid,
      choice: 'Withdraw_Stream',
      choiceArgument: { withdrawTime: new Date().toISOString() }
    }
  }]
});
```

The wallet prompts the user; on approval, the withdrawal is signed by
the recipient's wallet directly.

---

## Error handling

EIP-1474 error codes flow through as `CIP103Error`:

```ts
try {
  await provider.prepareExecute(req);
} catch (err) {
  if (err.code === ErrorCode.USER_REJECTED) {
    showToast('User cancelled');
  } else if (err.code === ErrorCode.DISCONNECTED) {
    showReconnectPrompt();
  } else {
    console.error('Unknown CIP-103 error', err);
  }
}
```

See `errors.ts` for the full error code constants.

---

## Production checklist

- [ ] CIP-103 OpenRPC conformance suite passes (see `cip-103-conformance.md`)
- [ ] Asset registry includes the production InstrumentRef + Scan endpoint for every asset you accept
- [ ] You subscribe to `accountsChanged` so the UI re-binds when the user switches accounts
- [ ] You handle `statusChanged → disconnected` by prompting reconnect, not by silently failing
- [ ] You don't store JWT bearer tokens in localStorage (Path A doesn't need them; the wallet handles signing)
- [ ] Featured-app marker emission is reviewed against the current CIP-0047/CIP-0104 regime before enabling it
