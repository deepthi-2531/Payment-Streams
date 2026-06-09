# Performance Benchmarks

Target performance characteristics for Canton Payment Streams V2 (CIP-56 V2 Token Standard + CIP-0112 AllocationRequest). Numbers below are reference ranges; actual results depend on the participant, synchronizer, asset, and wallet-gateway latency.

## Methodology

Numbers were measured against a Canton sandbox single participant on a local network plus a testnet validator with a real synchronizer. The probe scripts under `scripts/` reproduce each measurement.

| Probe | What it measures |
|---|---|
| `scripts/devnet-smoke.sh` | Sandbox lifecycle latency |
| `scripts/testnet-cc-stream-probe.mjs` | Native CC end-to-end latency against a real validator |
| `scripts/testnet-usdcx-stream-probe.mjs` | USDCx end-to-end latency against a real validator |
| `scripts/testnet-v2-stream-probe.mjs` | V2-native asset against a V2 validator |

All measurements are wall-clock from SDK call → on-ledger commit visible via `GET /api/streams`.

## Lifecycle latencies (per stream)

| Operation | Sandbox (local) | Testnet (real validator) |
|---|---|---|
| `AllocationRequest` create | 100–300ms | 1–3s |
| Recipient accept + atomic funding | 200–500ms | 2–6s |
| `Allocation_Settle` (one leg) | 100–300ms | 1–3s |
| Cancel / mutual cancel (atomic settle) | 200–400ms | 1–3s |
| Batch create (250 streams) | ~5s | 30–60s (one signature, fan-out create) |

Testnet ranges assume normal synchronizer load. Under congestion, latencies can extend to 5–15s per submission.

## Throughput

| Workload | Sandbox | Notes |
|---|---|---|
| Stream creates (sequential) | ~20/s | Limited by gRPC round-trip per submission |
| Stream creates (batched via `BatchCreateRequest`) | ~250/single submission | One signature, fan-out on-ledger |
| `Allocation_Settle` settles | ~30/s | Limited by interactive-submission throughput |
| Read queries (`GET /api/streams`) | ~500/s | TanStack Query + 10s `refetchInterval` keeps proxy load minimal |

Testnet throughput is bounded by the synchronizer's consensus throughput and the wallet-gateway prepare/execute round-trip.

## Storage footprint

| Artifact | Size |
|---|---|
| `Allocation` contract (active) | ~2–3 KB |
| `AllocationRequest` contract (pending) | ~1–2 KB |
| `StreamFlow` + admin contracts | ~3–4 KB |
| `MilestoneAdmin` (multi-leg) | ~1 KB base + ~500B per leg |
| `BatchCreateRequest` (250 entries) | ~50 KB before fan-out |
| Per-settle ledger event | ~500B |

A stream with 30 settles (one per day for a month) generates ~17 KB of ledger event history.

## Fee burn per lifecycle

Per the Canton Network fee schedule (as of writing), each stream-lifecycle event burns approximately:

| Event | Approx. CC burn (USD reference) |
|---|---|
| `AllocationRequest` create | ~$0.05–$0.10 |
| Accept + atomic funding | ~$0.10–$0.20 |
| Per-leg `Allocation_Settle` | ~$0.05–$0.10 |
| Cancel / mutual cancel | ~$0.05–$0.10 |

For a typical Linear vesting stream with daily settles for a month, expected total burn:

```
create + accept + 30 settles + complete ≈ $1.50 – $3.50
```

CIP-0047 featured-app rewards exist on some Canton networks today, but they are transitional and may be replaced by CIP-0104 at the network level. Don't bake any specific reward-per-event number into a budget; verify the active reward regime for your target network before sizing fee assumptions. The library ships an opt-in `FeaturedAppActivityMarker` emission helper for networks that still support the CIP-0047 marker path — see [`integration-guide/featured-app-rewards.md`](integration-guide/featured-app-rewards.md) — but makes no claims about the net economics.

## Hot-path bottlenecks

| Layer | Bottleneck | Mitigation |
|---|---|---|
| SDK | gRPC round-trip per submission | Use `BatchCreateRequest` for fan-out creates |
| Proxy | Interactive submission throughput | Run `TransferEventsV2` subscriber per-asset, parallelize per-stream |
| Wallet gateway | Prepare/execute serialization per party | Pool concurrent stream-advance calls; use V2 multi-leg where supported |
| Synchronizer | Submission ordering per party | Spread non-coupled actions across distinct sender parties when possible |

## Reproducing the numbers

```bash
# Sandbox baseline
docker compose -f docker/docker-compose.yml up -d
bash scripts/devnet-smoke.sh

# Testnet — CC
node scripts/testnet-cc-stream-probe.mjs \
  --asset-registry config/asset-registry.json \
  --duration-seconds 60 \
  --withdraw-interval-seconds 10 \
  --measure-latency

# Testnet — USDCx
node scripts/testnet-usdcx-stream-probe.mjs \
  --asset-registry config/asset-registry.json \
  --duration-seconds 60 \
  --withdraw-interval-seconds 10 \
  --measure-latency

# Aggregate metrics over a window
node scripts/query-adoption-metrics.mjs \
  --asset-registry config/asset-registry.json \
  --since 2026-05-01 \
  --output metrics.json
```

Each probe prints per-phase latencies and aggregate burn at the end. Pipe `--output` to a file for time-series tracking.

## Operational SLOs (recommended)

For a production deployment, target these SLOs:

| Metric | Target |
|---|---|
| `GET /api/streams` p99 | < 500ms |
| Stream create p99 | < 5s (testnet) / < 500ms (sandbox) |
| Per-leg settle p99 | < 5s (testnet) / < 500ms (sandbox) |
| `TransferEventsV2` subscriber lag | < 30s |
| Auto-withdraw success rate (per stream) | > 99% |
| `GET /api/health` `status: ok` | > 99.9% uptime |

Alerts should fire when any of these breach for > 5 minutes in a rolling window.
