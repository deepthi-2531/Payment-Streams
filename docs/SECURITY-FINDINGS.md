# Security Findings Register

This register records the findings from the internal security review of the
Canton Payment Streams reference stack (Daml contracts, TypeScript SDK, REST
proxy, executor daemon, CLI, dashboard, and the operational surface), the fix
that addressed each one, and how the fix was verified.

It is the public record the project keeps as findings are remediated. The
scope and preparation for an **independent external review** are in
[AUDIT-SCOPE.md](AUDIT-SCOPE.md); that engagement is a separate step the
maintainers run, and its report will be linked here when complete.

Fixes reference the commit that landed them on the `str-129-e2e-harness`
working branch. Verification is by the test suites in the repo
(`pnpm -r build`, `daml test`, the SDK/proxy/dashboard unit suites) plus the
manual checks noted per finding.

## Status summary

| Severity | Count | Fixed | Accepted / by design |
|----------|-------|-------|----------------------|
| Critical | 3  | 3  | 0 |
| High     | 7  | 7  | 0 |
| Medium   | 18 | 18 | 0 |
| Low / Info | 24 | 22 | 2 |
| Follow-up pass | 7 | 7 | 0 |

All Critical and High findings are remediated. The two accepted Lows are
display-only/by-design and carry no fund-movement risk (noted below).

## Critical

| ID | Component | Finding | Status | Fix | Verification |
|----|-----------|---------|--------|-----|--------------|
| CR-1 | Daml | Recipient could drain the full escrow on day one — withdraw choices accepted a caller-supplied `withdrawTime` never bounded to ledger time. | Fixed | `25e83fa` | `getTime` bound + `withdrawTime <= now` added to every withdraw choice; `daml test` invariants suite green. |
| CR-2 | Daml | Sender could back-date `cancelTime` to seize the recipient's vested funds. | Fixed | `25e83fa` | Same ledger-time bound on every cancel choice; conservation invariant asserted. |
| CR-3 | Proxy | Auth defaulted to spoofable dev mode and could mint ledger JWTs for any party. | Fixed | `25e83fa` | Default is now `jwt` (JWKS-verified); dev mode fails closed unless explicitly acknowledged. Verified in proxy auth tests. |

## High

| ID | Component | Finding | Status | Fix | Verification |
|----|-----------|---------|--------|-----|--------------|
| H-1 | Daml | Sender refund misrouted to the recipient's account on local-asset cancel. | Fixed | `25e83fa` | `senderAccount` threaded through; refund settles to the sender's own account. |
| H-2 | Proxy | Cross-party reads — list/get/history routes did not scope to the caller. | Fixed | `25e83fa` (+ `e5be0a4` for `/history`) | Participation check (sender/recipient/operator) enforced on every read route. |
| H-3 | Proxy | No rate limiting, body-size cap, or pagination. | Fixed | `25e83fa` | In-process rate limiter (default 120/60s), `express.json` body cap, list pagination. |
| H-4 | SDK / Exec / CLI | Bearer JWT attached over plaintext gRPC by default. | Fixed | `ba32d6f` | TLS defaults to true; tokens refused on insecure non-loopback channels without explicit opt-in. |
| H-5 | CLI / Scripts | Credentials accepted as command-line flags (leak via `ps`/history). | Fixed | `ba32d6f` | `--token`/`--admin-token` removed; env-var path is the only one. |
| H-6 | Scripts / CI | DAR supply chain was trust-on-first-use; nothing verified fetched DARs. | Fixed | `9afe973` (+ `e5be0a4` committed the pin manifest) | `scripts/v2-dar-pins.json` committed; fetcher fails closed on hash mismatch; CI defaults to the pinned commit. |
| H-7 | Docker | Compose exposed the unauthenticated Admin API on `0.0.0.0`. | Fixed | `ba32d6f` | Published ports bound to loopback. |

## Medium

| ID | Component | Finding | Status | Fix | Verification |
|----|-----------|---------|--------|-----|--------------|
| M-1 | SDK | `int64` ledger offsets parsed with `parseInt`, losing precision above 2⁵³. | Fixed | `9e35f48` | BigInt-safe offset conversion. |
| M-2 | Daml | `PolicyExecutionState` rate-limit bypass via a caller-chosen state cid. | Fixed | `9e35f48`, `7420c1b` | Every identifying party field of the fetched state is bound to the policy (contract keys unsupported on the LF target). |
| M-3 | Daml | `ExecutePolicy` did not assert `amount > 0`. | Fixed | `9e35f48` | Strict positive-amount assertion added. |
| M-4 | Daml | No `ensure` on vesting-mode validity (e.g. zero step interval) → funds could be permanently locked. | Fixed | `9e35f48` | `validVestingMode` in every escrow `ensure`. |
| M-5 | Proxy | JWT `audience` optional in `jwt` mode → tokens for other relying parties accepted. | Fixed | `25e83fa` (warn) → `e5be0a4` (enforced) | Proxy refuses to start in `jwt` mode without `PROXY_JWT_AUDIENCE` unless explicitly acknowledged; verified at runtime. |
| M-6 | Proxy | Service token compared with `!==` (timing-unsafe). | Fixed | `25e83fa` | Constant-time comparison. |
| M-7 | Proxy / SDK | Raw upstream/ledger error bodies returned to clients. | Fixed | `0bb92a7` | Errors logged server-side with a correlation id; clients get a safe message. |
| M-8 | Proxy / SDK | Amounts/party-ids/contract-ids cast without validation. | Fixed | `0f112dd` | Request-boundary validation (`validation.ts`) + settlement-leg guards; 400 on bad input. |
| M-9 | SDK | No timeout on outbound fetch; redirects replayed the Authorization header. | Fixed | `0bb92a7` (+ `0f112dd`, `9dab293`) | `redirect: 'error'` + abort timeout on every token-bearing fetch site. |
| M-10 | SDK / Proxy | In-process signing key not verified against the expected party key. | Fixed | `0f112dd` | Loaded key derived and checked against the expected public key; fail-closed. |
| M-11 | CLI | Config file token written world-readable. | Fixed | `27a6a10` | Config written `0600`. |
| M-12 | CLI | `sandbox` built shell strings from inputs → command injection. | Fixed | `27a6a10` | No-shell `spawnSync` argv + party-id validation. |
| M-13 | Proxy | Unbounded subscriber expiry map and per-event synchronous file reads. | Fixed | `0f112dd` | Expiry map capped; async offset reads; no full-body retention. |
| M-14 | Proxy | Off-chain transfer executed before the ledger record (atomicity gap). | Fixed | `4390b5f` | Durable settlement journal persists each settlement across the window; next cycle recovers a pending ledger record; double-pay guard skips streams with a pending settlement. |
| M-15 | Exec | `fetchRecentExecutions` scanned the entire never-archived `ExecutionLog`. | Fixed | `0f112dd` | Query bounded to the policy's rate-limit window. |
| M-16 | Exec | Racy in-memory idempotency check could double-submit. | Fixed | `0f112dd` | Reserve-before-submit + restart-safe one-shot guard; on-ledger rate limit is the cross-instance backstop. |
| M-17 | Scripts / CI | `curl | sh` SDK installers unpinned/unverified. | Fixed | `0f112dd` (+ `9dab293`) | Installers pinned and checksum-verified; CI defaults to the pinned splice ref. |
| M-18 | Docker | `--frozen-lockfile || pnpm install` silent fallback. | Fixed | `0f112dd` | Fallback removed; lockfile mismatch fails the build. |

## Low / Info

| ID | Component | Finding | Status | Fix | Verification |
|----|-----------|---------|--------|-----|--------------|
| L-1 | Dashboard | Dev JWT persisted to `sessionStorage`. | Fixed | `0f112dd` | Token kept in memory only. |
| L-2 | Dashboard | Loop wallet token read from `localStorage`. | Fixed | `0f112dd` | Held in memory; persisted entry removed on read. |
| L-3 | Dashboard | `build.sourcemap: true` shipped original TS. | Fixed | `ed13611` | Sourcemaps off for production. |
| L-4 | Dashboard | Money values round-tripped through float for display/batch totals. | Fixed | `4390b5f` | Decimal-safe formatting + Decimal batch sum (submission already preserved precision). |
| L-5 | Dashboard | Stored `proxyUrl` used unvalidated as a fetch base. | Fixed | `0f112dd` | `safeProxyUrl` validates absolute http(s); falls back to same-origin. |
| L-6 | Dashboard | No CSP. | Fixed | `0f112dd` | CSP meta added (frame-ancestors noted as a serving-layer header). |
| L-7 | SDK | Local debug scratch files tracked in git. | Fixed | `27a6a10` | Removed and gitignored. |
| L-8 | SDK | `withRetry` retried command submissions (double-submit risk). | Fixed | `0f112dd` | Submissions are non-retryable; reads still retry. |
| L-9 | SDK | Act-as/read-as headers built without CR/LF/comma checks. | Fixed | `ed13611` | Header values validated; injection rejected. |
| L-10 | SDK | Remote metadata trusted to set the `paused` safety flag. | Fixed | `0f112dd` | Remote shape validated; `paused` fails safe to true unless a strict boolean `false`. |
| L-11 | Daml | `ExecutionLog.success` hardcoded `True`; comment overclaimed auditability. | Fixed | `9e35f48` | Comment corrected to reflect abort-on-failure semantics. |
| L-12 | Daml | Per-milestone `amount` not constrained `> 0`. | Fixed | `9e35f48` | Per-milestone positive-amount `ensure`. |
| L-13 | Daml | `StreamFlow.Withdraw_Flow` unbounded `withdrawTime`. | Fixed | present | `getTime` bound present on `Withdraw_Flow`; verified in source. |
| L-14 | Daml | Admin confirm/cancel choices are operator-only (operator can desync the admin record from real settlement). | Accepted (by design) | `4390b5f` | Documented trust boundary on `MilestoneAdmin`: the V2 `Allocation` is authoritative; consumers reconcile against it. |
| L-15 | Scripts | GitHub Actions pinned to mutable tags. | Fixed | `0f112dd` | All actions pinned to verified commit SHAs. |
| L-16 | Scripts | Workflows lacked `permissions:` blocks. | Fixed | `27a6a10` | Least-privilege `GITHUB_TOKEN` scopes added. |
| L-17 | Scripts | `${{ inputs.* }}` interpolated into `run:` blocks. | Fixed | `27a6a10` | Inputs passed via env, not interpolated. |
| L-18 | Scripts | Release publish gated only on tag push. | Fixed | `0f112dd` | Protected `release` environment + OIDC; tag-vs-version verified. |
| L-19 | Scripts | Hardcoded bastion host/validator IP defaults. | Fixed | `0f112dd` | Replaced with env-var placeholders. |
| L-20 | Scripts | Example config normalized a plaintext secret / shipped a real fingerprint. | Fixed | `0f112dd` | Example configs sanitized to obvious placeholders. |
| L-21 | Scripts | Two probes consumed raw Ed25519 keys from env. | Fixed | `4390b5f` | Migrated to gateway-held signing keys. |
| L-22 | Docker | Containers ran as root. | Fixed | `0f112dd` | Non-root `USER` in every Dockerfile. |
| L-23 | Scripts | `check-tunnel.sh --fix` `kill -9`'d any port holder by name. | Fixed | `0f112dd` | Matches the expected command, prefers SIGTERM, refuses ambiguous matches. |
| L-24 | Docs | Internal reports published a third party's party-ids/holdings. | Fixed | `0f112dd` | Reports redacted and the whole reports directory gitignored. |

## Follow-up review pass

A second pass verified the remediations and caught partial/inconsistent fixes.

| ID | Component | Finding | Status | Fix | Verification |
|----|-----------|---------|--------|-----|--------------|
| NI-1 | Scripts | DAR pin manifest required by the verifier was never committed. | Fixed | `e5be0a4` | `scripts/v2-dar-pins.json` committed (11 DARs); fetcher verifies against it. |
| NI-2 | Scripts | `get-dependencies.sh` checksum enforcement inert by default. | Fixed | `e5be0a4` | Fail-closed by default with an explicit one-time pin bootstrap; already-present DARs verified too. |
| NS-1/2/3 | SDK / Proxy | Redirect+timeout guard reached only some token-bearing fetch sites. | Fixed | `e5be0a4`, `9dab293` | `redirect: 'error'` + abort timeout applied to every token-bearing fetch (amulet, transfer-offer, host-wallet, subscriber, orchestrator, readiness, signing transport). |
| ND-1 | Daml | `checkInvariant` added to `Cancel_*` but not `MutualCancel_*`. | Fixed | `e5be0a4` | Conservation invariant asserted in all three MutualCancel choices; `daml test` green. |
| NP-1 | Proxy | `/history` route missed the read-scope check. | Fixed | `e5be0a4` | Same participation check as the getter. |
| M-5 (enforce) | Proxy | Audience enforcement was downgraded to a startup warning. | Fixed | `e5be0a4` | `assertAuthConfigSafe` refuses to start in `jwt` mode without an audience unless explicitly acknowledged. |

## How to reproduce verification

```bash
pnpm install && pnpm -r build          # all packages build
pnpm --filter @canton-streams/sdk test # SDK unit suites
pnpm --filter @canton-streams/dashboard test
(cd packages/proxy && for f in test/*.test.mjs; do node --test "$f"; done)
(cd packages/daml/test && daml test)   # Daml-script suites incl. invariants
```

Report a new vulnerability privately to the maintainers — do not open a
public issue or PR. Support and maintenance policy is in
[docs/SUPPORT.md](SUPPORT.md).
