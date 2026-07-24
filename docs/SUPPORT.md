# Support and Maintenance

This document describes which versions of Canton Payment Streams are
maintained, what the maintenance window covers, how security and bug fixes are
prioritized, and how to get help. To report a vulnerability, contact the
maintainers privately — do not open a public issue or PR.

## Supported Versions

The project ships a single coherent release line across the workspace packages
(`@canton-streams/sdk`, `@canton-streams/cli`, and the private proxy, dashboard,
and executor packages) and the `canton-streams` DAR. See
[RELEASING.md](../RELEASING.md) for the release model.

| Version line | Status | Notes |
| --- | --- | --- |
| `1.0.0` | Stable | First stable release. npm packages use `1.0.0`; the `canton-streams` DAR uses numeric version `1.3.0`. |
| `0.2.x` | Maintenance | Previous evaluation line. Use the latest `1.0.0` release for new integrations. |
| `< 0.2.0` | Not supported | Pre-release lines receive no fixes. |

This table is the authoritative supported-versions matrix.

### Minor-line support policy

- The most recent minor line is the actively maintained line.
- When a new minor line ships, the previous minor line remains eligible for the
  maintenance window described below until that window closes.
- Patch releases (`x.y.Z`) within a supported minor line carry security and
  critical-bug fixes; integrators should track the latest patch of their line.

## Maintenance Window

Each release is covered by a **6-month maintenance/support window** from its
release date, consistent with the project's stated maintenance commitment.

The maintenance window **covers**:

- Security patches for the supported version line (see the SLA targets below).
- Critical bug fixes that block correct stream creation, settlement, or
  cancellation.
- Dependency and Canton-version compatibility updates needed to keep the
  supported line building and running, including the CIP-56 Token Standard V2
  and CIP-0112 AllocationRequest surfaces it depends on.

The maintenance window **does not cover**:

- New features or enhancements (these land on the active development line).
- Backports of new functionality to older minor lines.
- Bespoke integration support, custom adapters, or production operations for a
  specific deployment.
- Wallet implementations or wallet-side behavior; bring a CIP-103 wallet.

## Security-Patch SLA

Report vulnerabilities privately to the maintainers — not in a public issue
or PR. Reports are **acknowledged within 5 business days**, fixes are
coordinated privately, and a changelog entry is published once a remediation
is available.

The cadence below describes **targets** for triage and remediation by severity.
These are planning targets, not contractual guarantees; actual timelines depend
on reproducibility, upstream dependencies, and coordinated-disclosure needs.

| Severity | Triage target | Fix target |
| --- | --- | --- |
| Critical | Within the 5-business-day acknowledgement window | Coordinated patch as fast as practical |
| High | Within the 5-business-day acknowledgement window | Next patch release for the supported line |
| Medium | Within 10 business days | Rolled into a scheduled patch or minor release |
| Low | Best effort | Addressed opportunistically, typically with related work |

Every entry in the "Triage target" and "Fix target" columns is a **target**,
not a firm commitment. The only firm commitment is the 5-business-day
acknowledgement of privately reported vulnerabilities.

## Maintainer Ownership Model

Ownership is **role-based**. The project does not assign these responsibilities
to named individuals in this document; routing is by role and channel.

- **Maintainers** review issues and pull requests, decide what lands on the
  active line, and cut releases following [RELEASING.md](../RELEASING.md).
- **Security contact** is a private channel to the maintainers. Security
  reports are handled privately, not in public issues or pull requests.
- **Release decisions** — what ships, when, and on which line — are made by the
  maintainers, who also confirm version alignment across manifests, the
  changelog, and the DAR before tagging.

Routing summary:

| Item | Where it goes | Who acts |
| --- | --- | --- |
| Bug report or feature request | GitHub issue | Maintainers triage and label |
| Code change | Pull request (see [CONTRIBUTING.md](../CONTRIBUTING.md)) | Maintainers review and squash-merge |
| Security vulnerability | Private channel to the maintainers | Security contact / maintainers, privately |
| Code-of-conduct concern | Channels in [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Maintainers |

## How to Get Support

- **Self-serve first.** The docs are the primary support path. Start with the
  [README](../README.md) and the [integration guide](./integration-guide/README.md),
  then the [Quick Start](./QUICKSTART.md), [Architecture](./ARCHITECTURE.md),
  [Deployment](./DEPLOYMENT.md), and [API](./API.md) references.
- **Bugs and feature requests:** open a GitHub issue. Include the affected
  package and version, deployment or settlement mode if relevant, and
  reproduction steps.
- **Security vulnerabilities:** do **not** open a public issue. Report them
  privately to the maintainers.
- **Contributing a fix:** see [CONTRIBUTING.md](../CONTRIBUTING.md) for setup,
  testing, and the pull-request process.

## End-of-Life Policy

A version line reaches end of life (EOL) when its 6-month maintenance window
closes or when a newer line has superseded it and its window has elapsed.

- **Notice:** deprecation of a supported line is announced in the changelog and
  in the release notes for the release that supersedes it, ahead of the line's
  EOL date where practical.
- **After EOL:** an end-of-life line receives no further security patches,
  bug fixes, or compatibility updates. Integrators should upgrade to a
  supported line before their line's window closes.
- **Upgrading:** because the workspace tracks one coherent version across
  packages and the DAR, upgrade the SDK/CLI and re-vet the `canton-streams` DAR
  together. See [RELEASING.md](../RELEASING.md) and
  [docs/DEPLOYMENT.md](./DEPLOYMENT.md).
