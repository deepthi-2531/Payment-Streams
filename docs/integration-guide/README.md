# Integration Guide

Welcome. This guide walks third-party dApp developers through
integrating Canton Payment Streams.

The library is shipped as:

- A Daml on-ledger primitive (escrow + workflow templates)
- A TypeScript SDK (`@canton-streams/sdk`)
- A CIP-103-conformant dApp Provider for browser-wallet flows
- A reference REST proxy + React dashboard

You do not need all of them. Most integrations use the SDK directly
(server side) or the SDK + the CIP-103 Provider (browser side).

---

## Where to start

| If you want to… | Read… |
|---|---|
| Understand the integration architecture in 5 minutes | this README (you're here) |
| **Use the V2-native AllocationRequest pattern (default going forward)** | [**`allocation-request-pattern.md`**](./allocation-request-pattern.md) |
| See a complete browser-wallet integration end-to-end | [`cip-103-walkthrough.md`](./cip-103-walkthrough.md) |
| Run the CIP-103 conformance suite against your dApp | [`cip-103-conformance.md`](./cip-103-conformance.md) |
| Configure your dApp for the right asset | [`per-asset-config.md`](./per-asset-config.md) |
| Earn CIP-0047 featured-app rewards | [`featured-app-rewards.md`](./featured-app-rewards.md) |
| Pick the right settlement mode for your asset (legacy adapter view) | [`per-settlement-mode.md`](./per-settlement-mode.md) — **deprecated path; new code SHOULD use the AllocationRequest pattern** |

---

## Three integration paths

Pick one per stream action based on **who signs**:

### Path A — End-user dApp (browser-wallet signing)

The standard CIP-103 case. Your dApp talks to a CIP-103 Provider in
the browser; the Provider talks to the user's wallet (Splice Wallet
Kernel or another CIP-103-compliant wallet); the wallet signs and
submits. Your dApp **never holds user keys**.

Use this path for:

- Recipients claiming their accrued vesting / LP rewards
- Users accepting a stream proposal
- Users canceling a stream they originated

### Path B — Institutional / treasury backend

A vault-backed backend service signs and submits using a controlled
service party. Keys live in the vault / HSM, never in process memory.

Use this path for:

- Treasury creating vesting streams for an employee cohort
- LP-incentive emissions cron driven by the program operator
- Validator billing cron operated by the service provider
- Auto-withdraw worker driving recurring claims

### Path C — Hybrid (most common in practice)

Users use Path A for actions they personally drive (claim, accept,
cancel). The platform backend uses Path B for operator / trigger /
automation actions. **Same on-ledger contracts** — only the signer
location differs.

---

## Minimum integration shape (≈30 lines)

```ts
import { CantonStreamsClient } from '@canton-streams/sdk';
import { loadAssetRegistry } from '@canton-streams/sdk/assets/registry';
import { buildVestingStream } from '@canton-streams/sdk/helpers';
import assetRegistryFile from './asset-registry.json' assert { type: 'json' };

// 1. Load the asset registry (per-asset routing)
const registry = loadAssetRegistry(assetRegistryFile);
const usdcx = registry.requireAsset('usdcx');

// 2. Construct the stream params via a use-case helper
const params = buildVestingStream({
  streamId: 'employee-alice-grant-1',
  sender: vestingAgentParty,
  recipient: aliceParty,
  totalAmount: '100000',
  startTime: new Date('2026-07-01'),
  durationDays: 365 * 4,        // 4-year vest
  cliffDays: 365,                // 1-year cliff
  instrumentRef: usdcx.instrumentRef!,
  escrowOperator: ourOperatorParty,
});

// 3. Submit via the SDK (Path B — server-side, service-account signing)
const client = new CantonStreamsClient(clientConfig);
const result = await client.createStream(params);

console.log('Stream created:', result.contractId);
```

For the browser-wallet (Path A) flow, the same params object is passed
into `provider.prepareExecute({...})`. See `cip-103-walkthrough.md`.

---

## What you do NOT need to do

- **Branch by asset name**: the library negotiates V1/V2 capability
  per CIP-0112 automatically. You pick an asset; the library picks the
  adapter version.
- **Manage your own signing**: use Path A (wallet) or Path B (vault).
  Don't roll your own.
- **Run your own Scan endpoint aggregator**: the asset registry +
  `query-adoption-metrics.mjs` handle multi-Scan routing.
- **Build your own dashboard from scratch**: the reference dashboard
  in `packages/dashboard/` is forkable, or you embed the CIP-103
  Provider directly in your existing UI.

---

## Asking for help

- **GitHub Discussions**: architecture + design questions
- **GitHub Issues**: bugs + feature requests
- **Canton Foundation Discord**: real-time community
- **`security@…`** (see SECURITY.md): private security disclosure