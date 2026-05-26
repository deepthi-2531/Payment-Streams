# Canton Payment Streams

On-ledger, vesting-aware payment streaming for [Canton](https://www.canton.network/). Daml templates + TypeScript SDK + REST proxy + reference React dashboard. Apache 2.0.

## Fit

Reach for it when you need:

- A fixed total over a fixed window — vesting, LP rewards, treasury distributions → `StreamAdmin`
- An open-ended recurring payment with variable per-period funding — subscriptions, infrastructure billing → `StreamFlow`
- A fixed total released in tranches gated on confirmable events — KPI grants, milestone payments → `MilestoneAdmin`

…all settled on-ledger as one atomic story (state, funding lock, recipient transfer).

Skip it when:

- You need anything other than the **CIP-56 V2 Token Standard**. This release is V2-only; legacy modes are removed.
- You want off-ledger book-keeping. This library is the opposite of that.
- You're looking for a wallet implementation. The dashboard talks to any [CIP-103](https://github.com/canton-foundation/cips/blob/main/cip-0103/cip-0103.md)-compliant wallet (e.g. the [Splice Wallet Kernel](https://github.com/canton-network/splice-wallet-kernel)); the wallet itself is out of scope.

## Integration recipe

1. **Pick a stream variant** (`StreamAdmin` / `StreamFlow` / `MilestoneAdmin`) — they share the same wallet integration and settle path; only the funding shape differs.
2. **Register your asset** in `config/asset-registry.json` with its admin party, Scan endpoint, wallet-gateway URL, and CIP-0112 capability flags. The SDK reads this at runtime; application code does not branch by asset.
3. **Deploy + vet the DAR** on your participant + synchronizer. The proxy's startup readiness checks (`PROXY_STARTUP_REQUIRE_VETTED_PACKAGES=1`) catch the upload-but-not-vetted failure mode before users hit it.
4. **Provision a least-privilege service principal** for the proxy via `scripts/provision-streams-service.mjs` — `CanReadAsAnyParty + CanActAs` on the escrow operator only, never an admin token.
5. **For trust-minimized recurring actions, use `DelegatedPolicy`** — bounds (expiry, rate limit, action allow-list, scope, cooldown) enforced on-ledger by the `ExecutePolicy` choice, every execution recorded in an append-only `ExecutionLog`, revocable by the sender at any time.

The reference proxy (`packages/proxy/`) ships an event-driven `TransferEventsV2` subscriber that drives `Allocation_Settle` on each accrual interval, so you don't write that from scratch. The reference executor (`packages/executor/`) runs against `DelegatedPolicy` bounds, so you don't write that either.

## Quick start (Docker)

```bash
git clone git@github.com:deepthi-2531/Payment-Streams.git
cd Payment-Streams
pnpm install
docker compose -f docker/docker-compose.yml up -d
# Dashboard:  http://localhost:3000   (click Connect wallet)
# REST proxy: http://localhost:4000
```

Local dev without Docker: see [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

## Packages

| Package | What's in it |
|---|---|
| `packages/daml/` | Stream-admin templates (`StreamAdmin`, `StreamFlow` + `StreamFlowAdmin`, `MilestoneAdmin`); `Settlement.AllocationBridge` view helpers; `Policy.DelegatedPolicy` + `ExecutionLog` |
| `packages/sdk/` | TypeScript client. `buildAllocationRequest`, runtime CIP-0112 capability negotiation, gRPC + JSON API transports |
| `packages/proxy/` | Express REST proxy + `TransferEventsV2` settlement subscriber |
| `packages/dashboard/` | React reference UI wired to `@canton-network/dapp-sdk` |
| `packages/cli/` | Operator CLI for batch creation + adoption metrics |
| `packages/executor/` | Bounded automation runner for `DelegatedPolicy` |

## Documentation

Read in this order:

1. [QUICKSTART](docs/QUICKSTART.md) — sandbox + first stream end-to-end
2. [ARCHITECTURE](docs/ARCHITECTURE.md) — what each package does, V2 capability negotiation, trust boundary
3. [INTEGRATION-EXAMPLE](docs/INTEGRATION-EXAMPLE.md) — concrete host-app integration walkthrough
4. [API](docs/API.md) — REST proxy endpoint reference
5. [DEPLOYMENT](docs/DEPLOYMENT.md) — env vars, DAR upload + vetting, production hardening
6. [THREAT-MODEL](docs/THREAT-MODEL.md) — trust boundaries, mitigations, residual risks

Specialist docs: [TESTNET-RUNBOOK](docs/TESTNET-RUNBOOK.md), [SWK-WALLET-RUNBOOK](docs/SWK-WALLET-RUNBOOK.md), [OPERATIONS](docs/OPERATIONS.md), [BENCHMARKS](docs/BENCHMARKS.md), [WALKTHROUGHS](docs/WALKTHROUGHS.md), the [integration-guide/](docs/integration-guide/) folder for CIP-103 + per-asset config + CIP-56 V2 type reference.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md). Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[Apache 2.0](LICENSE).
