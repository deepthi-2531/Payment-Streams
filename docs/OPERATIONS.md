# Operations Runbook

Production operations guide for Canton Payment Streams: service topology,
health and readiness, recommended service-level objectives, stateful
components and their backups, incident handling, upgrade and rollback, and
on-call ownership.

This complements [DEPLOYMENT.md](DEPLOYMENT.md) (how to deploy) by covering
how to run the system day to day. Where a procedure overlaps with deployment,
this document links rather than repeats.

The service-level targets below are **recommended targets for an operator to
adopt**, not guarantees made by the project. Nothing here has been
load-tested or run as a production service by the project; treat the numbers
as starting points and tune them against your own measurements.

## 1. Service topology

The deployable units and the environment each one requires. Variable names
are the actual ones read by the code.

```text
Browser (Dashboard) --fetch--> Proxy (Express) --gRPC--> Canton participant
                                   |                          ^
                                   | JSON Ledger API          |
                                   v                          |
                          Wallet gateway (CIP-103)            |
                                                              |
Executor (DelegatedPolicy daemon) --gRPC----------------------+
```

### Participant (Canton node)

The ledger. Not part of this repo's build; supplied by your Canton/Splice
deployment. The local Docker stack runs a single sandbox participant
(`docker/Dockerfile.canton`) that publishes the Ledger API (gRPC) and Admin
API. In `docker/docker-compose.yml` both are **bound to loopback** by default
(`${DOCKER_BIND_HOST:-127.0.0.1}`) because the Admin API has no
authentication — anyone who can reach it can allocate parties, upload DARs,
and manage users.

| Concern | Value |
| --- | --- |
| Ledger API (gRPC) | `5001` -> container `6865` |
| Admin API | `5002` -> container `10011` |
| State volume | `canton-data` Docker volume |
| Health | `grpcurl -plaintext localhost:5001 grpc.health.v1.Health/Check` |

### Proxy (`packages/proxy`)

Express REST service that bridges the browser to the ledger over gRPC, runs
startup readiness checks, and optionally runs the auto-withdraw worker. Runs
as the unprivileged `node` user in `docker/Dockerfile.proxy`.

Core environment (see [DEPLOYMENT.md](DEPLOYMENT.md) for the full table):

| Variable | Purpose |
| --- | --- |
| `PROXY_PORT` | Listen port (default `4000`) |
| `CANTON_HOST` / `CANTON_PORT` | Ledger API gRPC target |
| `CANTON_USE_TLS` | gRPC TLS toggle |
| `CANTON_SYNCHRONIZER_ID` | Synchronizer/domain id streams are created on |
| `CANTON_STREAMS_PACKAGE_ID` | Vetted package id of the canton-streams DAR |
| `CANTON_JSON_API_URL` | JSON Ledger API base URL (required for readiness checks) |
| `PROXY_AUTH_MODE` | `jwt` (default, production) or `dev` |
| `PROXY_OIDC_ISSUER` / `PROXY_JWT_AUDIENCE` | JWT verification config (jwt mode) |
| `PROXY_SERVICE_TOKEN` / `PROXY_ESCROW_OPERATOR` | Service-tier auth for finalize / auto-withdraw |
| `ALLOWED_ORIGINS` | CORS allow-list (required in jwt mode) |
| `LOG_LEVEL` | pino log level |

Auth posture is fail-closed; see [auth.ts](../packages/proxy/src/auth.ts) and
incident **5.1** below.

### Executor (`packages/executor`)

Long-lived daemon that watches active `DelegatedPolicy` contracts and exercises
`ExecutePolicy` within each policy's on-ledger rate limit. It carries delegated
payout authority, so its token must not travel in plaintext — TLS defaults
**on** ([config.ts](../packages/executor/src/config.ts)).

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXECUTOR_LEDGER_HOST` | `localhost` | gRPC ledger host |
| `EXECUTOR_LEDGER_PORT` | `6865` | gRPC ledger port |
| `EXECUTOR_LEDGER_TLS` | `true` | TLS (set `false` only for a loopback/dev participant) |
| `EXECUTOR_LEDGER_TOKEN` | (empty) | Ledger JWT |
| `EXECUTOR_PARTY` | (empty, **required**) | Executor party id; startup throws if unset |
| `EXECUTOR_POLL_INTERVAL_MS` | `10000` | Cycle cadence |
| `EXECUTOR_MAX_CONCURRENT` | `5` | Max concurrent executions |
| `EXECUTOR_OFFSET_PATH` | `.executor-offset` | Offset checkpoint file (see section 4) |
| `EXECUTOR_GUARD_PATH` | `.executor-guard` | Idempotency guard file (see section 4) |
| `EXECUTOR_LOG_LEVEL` | `info` | pino level |

### Dashboard (`packages/dashboard`)

Static React SPA, built with Vite and served by Nginx as the unprivileged
`nginx` user on port `8080` inside the container (`docker/Dockerfile.dashboard`),
published as `3000` by compose. Configuration is **build-time** (Vite `VITE_*`
args), not runtime. See the dashboard env table in
[DEPLOYMENT.md](DEPLOYMENT.md): `VITE_PROXY_URL`, `VITE_WALLET_GATEWAY_URL`,
`VITE_SKIP_WALLET_PICKER`, `VITE_WC_PROJECT_ID`, and the wallet-layer args
(`VITE_WALLET_LAYER`, `VITE_WALLET_NAME`, `VITE_PARTYLAYER_*`).

### Wallet gateway (CIP-103)

An external CIP-103-compliant dApp gateway. It is **not** built by this repo;
it is operated alongside the stack. The dashboard talks to it from the browser
at the `VITE_WALLET_GATEWAY_URL` (default `http://localhost:3030/api/v0/dapp`).
When the proxy auto-withdraw worker routes signing through a gateway, it reads
`CANTON_STREAMS_WALLET_GATEWAY_URL` (or `WALLET_GATEWAY_URL`). Signing keys live
in the gateway's bound signing provider, never in the proxy process. Standing
it up is covered by [E2E-HARNESS.md](E2E-HARNESS.md).

## 2. Health and readiness

### `/api/health`

The proxy exposes one HTTP probe: `GET /api/health`
([index.ts](../packages/proxy/src/index.ts)). It returns the cached startup
readiness report and an overall status:

```json
{
  "status": "ok",            // "ok" or "degraded"
  "canton": { "host": "...", "port": 6865 },
  "readiness": { /* the ReadinessReport, or null */ }
}
```

`status` is `degraded` only when the cached startup readiness report is
`degraded`; otherwise `ok`. Health and readiness probes are exempt from the
proxy's in-process rate limiter so monitors are not throttled.

There is **no** separate `/ready` HTTP endpoint. Readiness is computed once at
startup and surfaced through `/api/health`. If any required readiness check
failed, the proxy logs the report and **exits with code 1** before binding the
listener — so a process that is up and answering `/api/health` has already
passed its required checks. Treat "process is listening" as the liveness
signal and the embedded `readiness` block as the readiness detail.

### Startup readiness checks

Implemented in [readiness.ts](../packages/proxy/src/readiness.ts) and gated by
env flags (all default off, i.e. skipped). Enable the relevant ones in
production:

| Check | Enable with | Failure means |
| --- | --- | --- |
| Package endpoint | `PROXY_STARTUP_REQUIRE_PACKAGE_ENDPOINT=1` | The canton-streams package id/name is not visible on the JSON Ledger API participant — DAR not uploaded or wrong `CANTON_STREAMS_PACKAGE_ID`. |
| Vetted packages | `PROXY_STARTUP_REQUIRE_VETTED_PACKAGES=1` | The package is on the participant but **not vetted** on the synchronizer — submissions would fail with `UNKNOWN_PACKAGE`. |
| Unknown vetting fatal | `PROXY_STARTUP_FAIL_ON_UNKNOWN_PACKAGE_VETTING=1` | Vetting state could not be determined and you have chosen to treat that as fatal. |
| Interactive submission | `PROXY_STARTUP_REQUIRE_INTERACTIVE_SUBMISSION_ENDPOINT=1` | `POST /v2/interactive-submission/prepare` is not reachable on the JSON API — the interactive auto-withdraw/settle path would fail. |

The package id pool is read from `CANTON_STREAMS_PACKAGE_ID` plus the optional
`CANTON_STREAMS_UTILITY_PACKAGE_ID`, `CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID`,
`CANTON_STREAMS_LOCAL_ASSET_PACKAGE_ID`, `CANTON_STREAMS_POLICY_PACKAGE_ID`, or
the explicit override `PROXY_STARTUP_REQUIRED_PACKAGE_IDS` /
`PROXY_STARTUP_REQUIRED_PACKAGE_NAMES`. When any check is enabled,
`CANTON_JSON_API_URL` must be set or every enabled check errors. Readiness
requests use the JSON API token from `CANTON_JSON_API_TOKEN` (falling back to
the service token).

### What to alert on

- **Proxy process not listening** -> page. The process exits non-zero on a
  failed required readiness check, so a crash-looping proxy almost always means
  a packaging/vetting or auth-config problem (sections 5.1, 5.2).
- **`/api/health` returns `status: "degraded"`** -> investigate. The startup
  readiness report inside the response names the failing check.
- **HTTP 429 (`rate_limit_exceeded`) spikes** -> a caller is exceeding the
  in-process limiter (see section 3).
- **Canton gRPC health check failing** -> the participant is the problem, not
  the proxy.

## 3. SLOs / SLIs

These are **recommended targets**, not commitments. Adopt and tune them per
deployment; none are guaranteed by the project. Each pairs a target (SLO) with
the signal you measure it from (SLI).

| Objective (recommended target) | Signal (SLI) |
| --- | --- |
| Proxy read request latency (p95) under a few hundred ms | Per-request structured pino logs; the proxy logs request latency per endpoint. |
| Write/settlement request latency tracked separately from reads | Same logs, segmented by route (writes call the ledger and are inherently slower than reads). |
| Settlement-cycle latency: a withdrawable stream is settled within one to two poll intervals | Auto-withdraw cycle logs (`Token-standard auto-withdraw cycle completed`) with `scanned/eligible/executed/failed`; executor cycle logs. The default poll interval is `10000` ms (proxy `PROXY_TOKEN_STANDARD_AUTOWITHDRAW_POLL_INTERVAL_MS`, executor `EXECUTOR_POLL_INTERVAL_MS`). |
| Readiness uptime: proxy passes its required startup checks on (re)deploy | Startup readiness log line / `/api/health` `status`; alert on `degraded` or crash-loop. |
| Error rate: 5xx responses kept to a small fraction of requests | `handleError` emits a server-side log with a `correlationId` (`<operation>-<base36 time>`) for every 5xx and returns the same id to the client. Count by `reason: internal_error`. |
| Auto-withdraw success rate near 100% of eligible streams per cycle | `executed` vs `failed` in the cycle result; `failed > 0` warrants a look. |

Signals available for measurement:

- **Proxy logs** — structured JSON (pino). Request latency per endpoint, gRPC
  error classes (`PERMISSION_DENIED`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`),
  auto-withdraw cycle summaries.
- **Correlation ids** — returned to the client on 5xx as `correlationId` and
  logged server-side; use them to join a client-visible failure to the full
  server log line. Client errors (4xx) keep their actionable message; 5xx
  bodies are deliberately generic (no internal hostnames/payloads) and carry
  only the id.
- **Executor cycle logs** — `Processing active policies`, per-policy cooldown
  skips, execution failures, and offset save per cycle.

Request-rate guardrail: the proxy ships an in-process fixed-window per-IP rate
limiter (default `120` requests / `60000` ms), tunable via
`PROXY_RATE_LIMIT_MAX` / `PROXY_RATE_LIMIT_WINDOW_MS` and disengageable with
`PROXY_RATE_LIMIT_DISABLE=true` when you front the proxy with a real gateway.
Request bodies are capped at `64kb` (`PROXY_BODY_LIMIT`).

## 4. Stateful components and backup/restore

The system keeps three small on-disk state files. All are written atomically
(write to `<path>.tmp`, then `rename`), so a crash mid-write cannot leave a
torn file — a hot copy of the file is always internally consistent. None of
them hold ledger truth (the ledger is the source of record); they exist to
make recovery safe and avoid replaying payouts.

| File | Path (env) | Default | Why it matters |
| --- | --- | --- | --- |
| Executor offset checkpoint | `EXECUTOR_OFFSET_PATH` | `.executor-offset` | Last processed timestamp; lets the executor resume after restart instead of rescanning from the beginning. |
| Executor idempotency guard | `EXECUTOR_GUARD_PATH` | `.executor-guard` | Set of in-flight/recently-completed execution ids; on restart it is loaded as a startup guard so a payout whose submit outcome was never observed is **not** replayed on the first cycle. |
| Settlement journal | `PROXY_SETTLEMENT_JOURNAL_PATH` | `.proxy-settlement-journal.json` | Durable record of in-flight interactive auto-withdraw settlements across the off-chain-transfer -> on-ledger-record window; the next cycle recovers a pending record instead of relying on log scraping. |

Implementations:
[offset.ts](../packages/executor/src/offset.ts),
[guard-store.ts](../packages/executor/src/guard-store.ts),
[settlement-journal.ts](../packages/proxy/src/settlement-journal.ts).

### Backup

- Put each file on persistent, durable storage (a mounted volume, not an
  ephemeral container layer). Configure the paths to point there.
- Because writes are atomic tmp+rename, a periodic file copy or a volume
  snapshot is safe to take at any time without quiescing the service.
- Most important to back up is the **settlement journal**: it is the only
  durable record bridging the window where funds have moved off-chain but the
  ledger record has not yet landed. The guard file is the executor's
  double-submit protection; the offset file is only a resume optimization.

### Restore behavior on restart

- **Offset** — `load()` returns the saved timestamp, or `null` if missing or
  unreadable; the executor logs "Resuming from saved offset" or starts fresh.
  Save failures are non-fatal (logged warning); the executor still runs.
- **Guard** — `load()` returns the persisted ids (empty array if
  missing/unreadable). They seed `startupGuard`, consulted only for the first
  cycle, then cleared so legitimate recurring payouts are not skipped.
  Cross-instance racing is bounded by the on-ledger `DelegatedPolicy` rate
  limit, not this file.
- **Settlement journal** — entries reload on first access. On the next cycle,
  `record`-phase entries are re-submitted with their original `commandId` and
  `contractId` (Canton dedups a record that already landed; an archived
  contract / duplicate command clears the entry). `transfer`-phase entries are
  **surfaced for manual reconciliation only** — their off-chain outcome is
  unknown and they are never retried automatically. See incident 5.3.

A missing state file is never fatal: the system starts with empty state and the
on-ledger contracts plus Canton's command-id dedup remain the safety net.

## 5. Incident handling

Each runbook entry is: detection signal -> diagnosis -> action. Ledger truth is
authoritative; when in doubt, query the ledger before acting.

### 5.1 Proxy refuses to start (fail-closed auth misconfiguration)

- **Detection** — proxy exits non-zero immediately; no "listening on :PORT"
  line. Startup log carries a "Refusing to start" message.
- **Diagnosis** — `assertAuthConfigSafe` in
  [auth.ts](../packages/proxy/src/auth.ts) blocks three unsafe postures:
  1. `PROXY_AUTH_MODE=dev` without `PROXY_ALLOW_DEV_AUTH=true` — dev mode trusts
     the `X-Canton-Party` header and mints ledger JWTs for arbitrary parties.
  2. Acknowledged dev mode without an explicit loopback bind — requires
     `PROXY_BIND_HOST=127.0.0.1` (or `::1`/`localhost`).
  3. `jwt` mode without `PROXY_JWT_AUDIENCE` and without
     `PROXY_ALLOW_ANY_AUDIENCE=true` — would accept any token the IdP minted for
     any relying party.
- **Action** — for any networked/production deployment, set
  `PROXY_AUTH_MODE=jwt`, `PROXY_OIDC_ISSUER`, and `PROXY_JWT_AUDIENCE`. Do not
  reach for the acknowledgement flags to make the error go away on a real
  deployment; they exist only for local dev. Restart.

### 5.2 DAR not vetted (readiness failure)

- **Detection** — proxy exits non-zero at startup with a degraded readiness
  report; the failing check is `vettedPackages` ("present but not vetted") or
  `packageEndpoint` ("Missing package IDs/names"). At runtime, submissions fail
  with `UNKNOWN_PACKAGE`.
- **Diagnosis** — the DAR is uploaded but not vetted on the synchronizer, the
  wrong `CANTON_STREAMS_PACKAGE_ID` is configured, or `CANTON_JSON_API_URL` is
  missing so checks could not run.
- **Action** — vet the package on the synchronizer and re-capture the package
  id (see the upload + vet steps in [DEPLOYMENT.md](DEPLOYMENT.md)), set
  `CANTON_STREAMS_PACKAGE_ID` to the new hash, confirm `CANTON_JSON_API_URL`,
  then restart. Verify `/api/health` returns `status: ok`.

### 5.3 Settlement journal entries stuck in `transfer` / `record`

- **Detection** — the proxy logs (from
  [auto-withdraw.ts](../packages/proxy/src/auto-withdraw.ts)) one of:
  - `Off-chain transfer outcome unknown (process died mid-transfer)` — a
    `transfer`-phase entry;
  - `Pending ledger record exceeded automatic recovery attempts` — a
    `record`-phase entry past the recovery cap (5 attempts);
  - `Pending ledger record cannot be auto-recovered in in-process signing mode`;
  - a critical structured event
    `autowithdraw.execute_failed_after_transfer`.
  An affected stream is also skipped on later cycles with "a prior settlement
  for this stream is pending reconciliation".
- **Diagnosis** — the interactive withdraw moves funds off-chain first and
  records on-ledger second. A `record`-phase entry means funds moved but the
  ledger exercise has not yet landed; recovery re-submits with the original
  `commandId`/`contractId` (Canton dedups, so a record that landed is detected,
  not double-applied). A `transfer`-phase entry means the off-chain transfer's
  outcome is unknown — recovery never retries it automatically.
- **Action**:
  - **`record` phase** — let the worker retry; if it has exhausted attempts or
    is running in-process signing mode, replay manually by re-issuing the same
    `commandId` (Canton dedups) or a `Withdraw_TokenStandard` exercise with the
    journaled `settlementReference`/`settledAmount`/`withdrawTime`. Once the
    ledger shows the record (or the contract is archived), remove the journal
    entry.
  - **`transfer` phase** — reconcile by hand: confirm with the wallet/registrar
    whether the off-chain transfer actually executed, then either complete the
    ledger record or treat the transfer as not-done, and remove the journal
    entry. Do not blindly re-run — there is intentionally no auto-rollback,
    because a compensating transfer risks a double-undo.

### 5.4 Executor double-submit suspicion

- **Detection** — two payouts for the same stream within a cooldown window, or
  duplicate `ExecutionLog` entries.
- **Diagnosis** — the executor has three layers
  ([index.ts](../packages/executor/src/index.ts)): a recent-execution
  idempotency check, an in-process reservation set written to the guard file
  before each submit, and a startup guard loaded from that file. None of these
  is cross-instance — the **on-ledger `DelegatedPolicy` rate limit (cooldown,
  period cap) enforced in `ExecutePolicy` is the final backstop** against two
  executors racing.
- **Action** — confirm only **one** executor instance is configured per
  `EXECUTOR_PARTY`. Ensure `EXECUTOR_GUARD_PATH` points at durable storage so
  the restart guard survives restarts. The ledger cannot be double-charged
  beyond what the policy's on-ledger rate limit allows; reconcile any apparent
  duplicate against the policy's cooldown and `ExecutionLog`. If you run more
  than one executor for availability, rely on the on-ledger rate limit as the
  arbiter rather than the local guard file.

### 5.5 Token / credential exposure

- **Detection** — a leaked `PROXY_SERVICE_TOKEN`, ledger JWT, escrow-operator
  signing key, or wallet-gateway credential.
- **Diagnosis** — the service token authorizes finalize/auto-withdraw routes
  (validated with a constant-time comparison); the escrow-operator key /
  gateway credential can authorize settlement transfers.
- **Action** — rotate the exposed secret immediately: revoke/rotate the ledger
  JWT at the IdP, set a new `PROXY_SERVICE_TOKEN`, and rotate escrow-operator
  signing material (`CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON` or the
  `PROXY_ESCROW_OPERATOR_*` env). Restart the affected services. Prefer holding
  keys in the wallet gateway's signing provider rather than the proxy process.
  For a confirmed vulnerability, coordinate privately with the maintainers —
  do not open a public issue or PR. Keep secrets in env vars, never in
  committed config.

## 6. Upgrade and rollback

### DAR upgrade and vetting

Follow the package build/upload/vet flow in [DEPLOYMENT.md](DEPLOYMENT.md):
build the DAR, upload it via the Admin API or `daml ledger upload-dar`, then
**vet** it on the synchronizer (upload alone is insufficient — unvetted
packages fail with `UNKNOWN_PACKAGE`). Each redeploy of changed Daml changes
the package id, so capture the new hash and set `CANTON_STREAMS_PACKAGE_ID`. The
SDK template registry reads it at startup, so **restart the proxy** for the
change to take effect.

### SDK / proxy version bump

1. Build and stage the new proxy image (`pnpm --filter @canton-streams/proxy
   build`, or rebuild the container).
2. Update `CANTON_STREAMS_PACKAGE_ID` if the DAR changed alongside the code.
3. Roll the proxy. Its required readiness checks gate the new version: if the
   new build cannot see/vet its package or reach the interactive-submission
   endpoint, it exits non-zero rather than serving in a broken state.
4. Confirm `/api/health` returns `status: ok` and watch error-rate and
   auto-withdraw cycle logs for a few cycles.

### Rollback expectations

Contract state lives **on-ledger and is immutable**. "Rollback" here means
redeploying the **prior package version** of the off-ledger components (proxy,
executor, dashboard) and/or pointing `CANTON_STREAMS_PACKAGE_ID` back at the
previously vetted package.

What rollback does and does not do:

- **Does** — restore the previous proxy/executor/dashboard behavior and the
  previous on-ledger code path for *new* actions.
- **Does not** — undo contracts already created or settlements already
  recorded on the ledger. Anything committed stays committed; there is no
  "unwind." Streams created against the newer package keep their on-ledger
  state and remain governed by the package they were created with.
- A package version downgrade may be refused by the participant's version
  machinery; treat a downgrade as a deliberate, vetting-gated operation, not a
  quick revert. Drain or pause new-stream creation before attempting one, and
  let in-flight settlements (and any journal entries) reconcile first.

For breaking changes between releases, consult
[../CHANGELOG.md](../CHANGELOG.md).

## 7. On-call ownership

Role-based ownership (roles, not individuals). Map these to your own rota.

| Component | Owning role | Responsible for |
| --- | --- | --- |
| Proxy, settlement journal, auto-withdraw worker | Application on-call | Proxy health/readiness, request error rate, journal reconciliation, service-token config. |
| Executor, guard/offset state, `DelegatedPolicy` execution | Application on-call | Executor liveness, single-instance invariant, cooldown/rate-limit behavior, double-submit triage. |
| Participant / ledger / synchronizer, DAR vetting | Ledger / infrastructure on-call | Canton node health, gRPC/JSON API availability, package upload and vetting, TLS. |
| Wallet gateway and signing provider | Wallet / integration on-call | CIP-103 gateway availability, allowed origins, escrow-operator key custody. |
| Dashboard (static SPA) | Application on-call | Build-time config, static hosting, CORS origins on the proxy. |

### Escalation path

1. **Application on-call** triages first (proxy/executor symptoms, journal,
   logs).
2. If the symptom is the **participant, JSON/gRPC API, or package vetting**,
   escalate to **ledger / infrastructure on-call**.
3. If the symptom is **wallet connection, signing, or gateway credentials**,
   escalate to **wallet / integration on-call**.
4. For a suspected **security incident** (credential exposure, auth bypass,
   unexpected on-ledger activity), report it privately to the maintainers — do
   not open a public issue; use a private reporting channel.

## See also

- [DEPLOYMENT.md](DEPLOYMENT.md) — how to deploy each component
- [E2E-HARNESS.md](E2E-HARNESS.md) — wallet-backed end-to-end harness
- [THREAT-MODEL.md](THREAT-MODEL.md) — security analysis and trust boundaries
- [../CHANGELOG.md](../CHANGELOG.md) — release/breaking-change notes

Report suspected vulnerabilities privately to the maintainers, not in a
public issue or PR.
