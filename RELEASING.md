# Releasing Canton Streams

## Release Model

This repo uses a shared release line for the workspace packages and the primary `canton-streams` DAR. The publishable npm packages are:

- `@canton-streams/sdk`
- `@canton-streams/cli`

Private packages such as the proxy, dashboard, and executor still track the same release line so a checkout has one coherent version across docs, changelog, and manifests.

## Before You Cut a Release

1. Update the changelog entry for the version you are shipping.
2. Align package versions in the workspace manifests.
3. Make sure the Daml package versions and DAR filenames referenced by the test/script packages are current.
4. Run the local release checks:

```bash
pnpm lint
pnpm --filter @canton-streams/sdk test
pnpm --filter @canton-streams/sdk build
pnpm --filter @canton-streams/cli build
pnpm daml:build
```

5. Confirm npm publish access and set the `NPM_TOKEN` GitHub Actions secret.

## Canonical Repository Metadata

If this checkout is becoming the public upstream repository, add the canonical `repository`, `homepage`, and `bugs` URLs to:

- `packages/sdk/package.json`
- `packages/cli/package.json`

Those URLs are intentionally not guessed in this repo, because publishing incorrect package metadata is worse than leaving it unset temporarily.

## Tag-Driven npm Releases

The release workflow lives at `.github/workflows/release.yml` and publishes from tags:

- `sdk-vX.Y.Z` publishes `@canton-streams/sdk`
- `cli-vX.Y.Z` publishes `@canton-streams/cli`

Examples:

```bash
git tag sdk-v0.2.7
git push origin sdk-v0.2.7

git tag cli-v0.2.7
git push origin cli-v0.2.7
```

The workflow will:

1. install dependencies with pnpm
2. verify that the tag version matches the target package manifest
3. build and test the SDK
4. build the CLI when releasing the CLI package
5. publish the selected package to npm with provenance
6. create a GitHub Release for the tag

## npm Publishing Notes

- The workspace uses pnpm, not npm, for publishing.
- `@canton-streams/cli` depends on `@canton-streams/sdk` via the workspace protocol so the published dependency version is derived from the workspace release line.
- Prefer tagging from a commit that has already passed CI on `main`.
