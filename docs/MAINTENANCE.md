# Maintenance And Support

Canton Payment Streams is open-source infrastructure for building payment
streams on Canton. This document describes how the project is maintained and
what adopters can expect from the release line.

## Supported Scope

The project maintains:

- Daml templates shipped in this repository.
- The TypeScript SDK and REST proxy.
- The dashboard reference implementation.
- Documentation and local development scripts.
- Compatibility with CIP-103 wallet connections and CIP-56 V2 token flows.

The project does not operate:

- Validator infrastructure.
- Third-party wallets.
- Canton Network services.
- Custom forks or private deployments.

## Security Patch SLA

| Severity | Definition | First response | Target patch |
| --- | --- | --- | --- |
| Critical | Loss of funds, signature bypass, unauthorized spend | 24 hours | 72 hours |
| High | Privilege escalation, policy bypass, material authorization flaw | 48 hours | 2 weeks |
| Medium | Information disclosure, denial of service, correctness bug | 1 week | 30 days |
| Low | Cosmetic, documentation, local-development issue | Best effort | Next minor release |

Do not open a public issue for security reports. Follow `SECURITY.md`.

## Versioning

Canton Payment Streams follows Semantic Versioning.

- Major releases may include breaking Daml template or SDK API changes.
- Minor releases add backwards-compatible features.
- Patch releases include bug fixes, security fixes, and documentation updates.

When an on-ledger template change requires adopters to upload a new DAR, the
release notes must call that out explicitly.

## Token Standard Compatibility

This project is V2-only. Assets that expose only older token interfaces are
not streamable through this library because the implementation relies on V2
allocation and settlement semantics.

When an asset advertises V2 allocation support, add it to
`config/asset-registry.json`. The SDK routes through the V2 capability gate
and fails closed when an asset is not compatible.

## Wallet Compatibility

The reference local wallet path is the Splice Amulet wallet through a
CIP-103-compatible gateway. Hosted deployments can use PartyLayer for
multi-wallet selection while keeping the same Streams SDK/proxy contract.

See:

- `docs/E2E-HARNESS.md`
- `docs/HOSTED-WALLET-PLAN.md`
- `docs/SWK-WALLET-RUNBOOK.md`

## Contributor Expectations

- Keep public docs free of internal issue references.
- Prefer small, reviewable pull requests.
- Run the relevant package tests before opening a PR.
- Update the README or integration docs when a user-facing flow changes.

## Channels

| Channel | Purpose |
| --- | --- |
| GitHub Issues | Bug reports, feature requests, documentation feedback |
| GitHub Security Advisories | Coordinated security disclosure |
| GitHub Discussions | Architecture and ecosystem questions |
| Canton community channels | Real-time ecosystem support |
