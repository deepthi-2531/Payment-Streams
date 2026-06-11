# Cutting a Release Candidate

The exact, reproducible checklist to cut a public release candidate
(`1.0.0-rc.1`) for Canton Payment Streams.

This document complements [RELEASING.md](../RELEASING.md), which covers
the steady-state per-package release model. Read that first; this file
is the RC-specific procedure and the owner-action accounting.

---

## Overview

Each step below is marked as one of:

- **[automated]** — performed by the release workflow on a tag push.
- **[manual]** — a maintainer/owner action that must be done by hand,
  often requiring credentials or repository-owner privileges.

The current versions in this checkout are `1.0.0-rc.1` across the workspace
npm packages and `1.0.0` for the `canton-streams` DAR
([`packages/daml/main/daml.yaml`](../packages/daml/main/daml.yaml)). The
numeric DAR version is the on-ledger artifact paired with npm
`1.0.0-rc.1`.

---

## 1. Versioning **[manual]**

Prepare npm package version `1.0.0-rc.1` and Daml package version `1.0.0`,
then tag.

### 1.1 Bump package versions

Confirm `version` is `1.0.0-rc.1` in:

- `package.json` (root)
- `packages/sdk/package.json`
- `packages/cli/package.json`
- `packages/proxy/package.json`
- `packages/dashboard/package.json`
- `packages/executor/package.json`

The private packages (proxy, dashboard, executor) track the same release
line so a checkout has one coherent version. Use `./sync-versions.sh` if
it covers your manifests; otherwise edit each manifest.

### 1.2 Bump the DAR version

Confirm the Daml package version in
[`packages/daml/main/daml.yaml`](../packages/daml/main/daml.yaml)
(currently `1.0.0`) and align the DAR filenames referenced by the
test package ([`packages/daml/test/daml.yaml`](../packages/daml/test/daml.yaml)),
which pins `canton-streams-1.0.0.dar` as a data-dependency. The optional
`packages/daml/scripts` helper package is source reference and not part of the
published RC gate.

> Daml SemVer does not accept a `-rc.1` pre-release suffix in
> `daml.yaml`. Keep the DAR on a numeric version (the next numeric
> version on the release line) and record the RC correspondence in the
> CHANGELOG and release notes. The npm packages carry the `1.0.0-rc.1`
> identity.

### 1.3 Tag scheme

The release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml))
listens only for tags matching `sdk-v*.*.*` and `cli-v*.*.*`. For the
RC:

```bash
git tag sdk-v1.0.0-rc.1
git push origin sdk-v1.0.0-rc.1

git tag cli-v1.0.0-rc.1
git push origin cli-v1.0.0-rc.1
```

### 1.4 Order of operations

1. Land the version bumps and the CHANGELOG entry on `main` and let CI
   pass.
2. Tag `sdk-v1.0.0-rc.1` from that commit and push — the workflow
   publishes the SDK first.
3. Tag `cli-v1.0.0-rc.1` and push — the CLI depends on the SDK via the
   workspace protocol, so the SDK must be published first.

Prefer tagging from a commit that has already passed CI on `main`.

---

## 2. Release Workflow Behavior

A tag push to `sdk-v*` or `cli-v*` triggers
[`.github/workflows/release.yml`](../.github/workflows/release.yml). The
`publish` job:

1. **[automated]** Resolves the release target from the tag
   (`sdk` → `@canton-streams/sdk`, `cli` → `@canton-streams/cli`); an
   unknown package prefix fails the job.
2. **[automated]** Installs dependencies with pnpm
   (`--frozen-lockfile`).
3. **[automated]** **Verifies the tag version matches the package
   manifest** — `sdk-v1.0.0-rc.1` must match the `version` field in
   `packages/sdk/package.json`, or the job fails. This is why step 1.1
   must land before tagging.
4. **[automated]** Builds and tests the SDK; builds the CLI when the
   release target is the CLI.
5. **[automated]** Publishes the selected package to npm with
   `--access public --provenance` (npm provenance via the
   `id-token: write` permission).
6. **[automated]** Creates a GitHub Release for the tag with
   auto-generated notes.

### The protected `release` environment gate **[manual setup]**

The `publish` job declares `environment: release`. A tag push **cannot**
publish to npm or mint provenance until the `release` environment's
protection rules are satisfied.

> **Owner setup step.** The repository owner must configure the
> `release` environment (Settings → Environments → `release`) with
> **required reviewers** and, optionally, branch/tag restrictions.
> Without required reviewers configured, the gate provides no human
> approval — configuring it is what makes the gate meaningful. This is a
> one-time owner action and is not something the workflow can do for
> itself.

### npm provenance and tag-vs-version verification

- Provenance is produced by `pnpm ... publish --provenance` together
  with the workflow's `id-token: write` permission; it binds the
  published tarball to the building workflow run.
- The tag-vs-version check (step 3 above) is the guard against a tag
  whose version does not match the manifest it claims to publish.

---

## 3. Pre-RC Gate Checklist **[manual]**

Run and confirm green before tagging:

```bash
# Build everything across the workspace (sdk, cli, proxy, dashboard, executor)
pnpm -r build

# Unit tests — the SDK and dashboard carry test suites
pnpm --filter @canton-streams/sdk test
pnpm --filter @canton-streams/dashboard test

# Daml build + script tests
pnpm daml:deps
pnpm daml:build
pnpm daml:test

# V2 upstream conformance lint (no forbidden V1 choice names)
bash scripts/check-v2-conformance.sh
```

> The proxy and executor packages ship a `build` script but no `test`
> script; `pnpm -r build` is their gate. The SDK and dashboard carry the
> unit-test suites. The Daml-script suites (`pnpm daml:test`) cover the
> on-ledger logic.

Also confirm:

- [ ] **No-mock / no-secret grep gates** — no committed mock fixtures or
      secrets in the publishable surface (run the repo's grep gates;
      confirm no API keys, tokens, private keys, or `.env` values are
      tracked).
- [ ] **Registry placeholder check** — review
      [`config/asset-registry.json`](../config/asset-registry.json).
      It currently carries `TBD-...` `walletGatewayUrl` placeholders
      (e.g. `TBD-v2-devnet-wallet-gateway`,
      `TBD-operator-wallet-gateway`). These are deployment-specific and
      are expected to remain placeholders in the published library, but
      confirm no real operator endpoint, IP, or party id has leaked in.
- [ ] **CHANGELOG updated** — add a `1.0.0-rc.1` entry to
      [CHANGELOG.md](../CHANGELOG.md) summarizing the feature set and the
      security remediation.
- [ ] **Canonical repository metadata** — confirm `repository`,
      `homepage`, and `bugs` URLs are set in `packages/sdk/package.json`
      and `packages/cli/package.json` (see
      [RELEASING.md](../RELEASING.md)).

---

## 4. Artifacts To Publish — and Who Publishes Them

| Artifact | How | Owner / credential |
|---|---|---|
| GitHub Release for `sdk-v1.0.0-rc.1` / `cli-v1.0.0-rc.1` with notes | **[automated by workflow]** on tag push (`softprops/action-gh-release`), gated by the `release` environment | Triggered by the maintainer who pushes the tag; approved by a `release` environment reviewer |
| npm RC publish of `@canton-streams/sdk` and `@canton-streams/cli` | **[automated by workflow]** with `--provenance` | Requires `NPM_TOKEN` secret / OIDC and the `release` environment approval — **owner action** to configure the secret and approve |
| Docker images (Canton, proxy, dashboard) | **[manual owner action]** — the images are built from [`docker/Dockerfile.canton`](../docker/Dockerfile.canton), [`docker/Dockerfile.proxy`](../docker/Dockerfile.proxy), [`docker/Dockerfile.dashboard`](../docker/Dockerfile.dashboard); CI builds the dashboard image but does not publish any image | Requires container-registry credentials — **owner action** |
| Making the repository public | **[manual owner action]** | Repository-owner privilege only |

> The CI pipeline ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml))
> builds the dashboard Docker image on pushes to `main` but does **not**
> push it to any registry. Publishing Docker images is a manual owner
> action with registry credentials.

### Credential / secret prerequisites **[manual owner action]**

- `NPM_TOKEN` GitHub Actions secret (or OIDC trust) — required for the
  npm publish step.
- The `release` protected environment configured with required reviewers
  (see §2).
- Container-registry credentials — required only for the manual Docker
  image publish.

---

## 5. Draft GitHub Release Notes — `1.0.0-rc.1`

> Use this as the body for the GitHub Release (the workflow's
> auto-generated notes can be appended below it).

```markdown
# Canton Payment Streams 1.0.0-rc.1

First public release candidate. Payment streams for Canton, built on the
CIP-56 Token Standard with V2 preferred and a transitional V1 lane for
registered assets that have not yet published V2.

## Feature set

- **Stream variants:** `StreamAdmin` (prefunded bounded streams),
  `StreamFlow` (rolling top-up / pause / resume / renew), and
  `MilestoneAdmin` (multi-leg milestone release).
- **Vesting modes:** Linear, CliffLinear, Stepped, RenewableTerm.
- **Token-standard settlement:** CIP-56 Token Standard V2 via the CIP-0112
  `AllocationRequest` pattern where available, plus the transitional V1
  allocation lane for registered assets that have not yet published V2;
  per-asset capability gating via `config/asset-registry.json` with no
  per-asset branching in dApp code.
- **Bounded delegated execution:** `DelegatedPolicy` enforces executor
  authority on-ledger (rate limit, cooldown, expiry, scope, action
  allow-list) with an append-only `ExecutionLog`.
- **Off-ledger tooling:** TypeScript SDK, REST proxy with a
  TransferEventsV2 subscriber, executor service, CLI, and a reference
  React dashboard with CIP-103 wallet integration.

## Security

The release candidate ships the time-bound guard remediation
(`getTime`-bounded `withdrawTime` / `cancelTime` / `renewTime` /
`completeTime` on every fund-moving choice), fail-closed proxy auth, and
the bounded-executor enforcement model. The full record of the internal
review and remediations is in
[docs/SECURITY-FINDINGS.md](https://github.com/OWNER/REPO/blob/main/docs/SECURITY-FINDINGS.md).
The scope for an independent external review is in
[docs/AUDIT-SCOPE.md](https://github.com/OWNER/REPO/blob/main/docs/AUDIT-SCOPE.md).

## Release candidate status

This is a release candidate. See the RC blockers in
[docs/RELEASE-CANDIDATE.md](https://github.com/OWNER/REPO/blob/main/docs/RELEASE-CANDIDATE.md)
before depending on it for production value transfer.
```

(Replace `OWNER/REPO` with the canonical repository slug once it is
fixed.)

---

## 6. RC Blockers

The following are **not yet done** and are owner or third-party actions.
They are honest blockers between this RC and a final `1.0.0` — none of
them is closed by the release workflow:

- **Independent external review not yet engaged** — the scope is
  prepared ([docs/AUDIT-SCOPE.md](AUDIT-SCOPE.md)) and the internal
  findings are recorded ([docs/SECURITY-FINDINGS.md](SECURITY-FINDINGS.md)),
  but commissioning the external reviewer is a maintainer procurement
  step that has not happened. **[owner / third-party action]**
- **Repository not yet public** — making the repo public is a
  repository-owner privilege. **[owner action]**
- **npm and Docker artifacts not yet published** — publishing requires
  `NPM_TOKEN` / OIDC and the `release` environment for npm, and
  registry credentials for Docker. **[owner action]**
- **Operator-specific registry values unset** —
  [`config/asset-registry.json`](../config/asset-registry.json) carries
  `TBD-...` wallet-gateway URLs (`walletGatewayUrl`). Each operator must
  point these at their own wallet gateway; the published library ships
  with placeholders. **[deployment / operator action]**
- **Funded-party live validation pending** — end-to-end settlement with
  a funded party against live USDCx and non-prefunded flows has not been
  completed; the live `Allocation_Settle` path was blocked on a
  participant package-version constraint during internal testing.
  **[owner / third-party action, requires funded parties]**
