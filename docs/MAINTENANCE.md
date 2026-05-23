# Maintenance and Support

Canton Payment Streams ships as production-grade open-source
infrastructure for the Canton Network. This document defines the
**maintenance and support window** committed alongside the v1.0.0 release
so early adopters know what to expect and the wider ecosystem can plan
around the library's lifecycle.

This commitment is part of the project's Milestone 3 acceptance criteria
(see Canton Payment Streams Linear project, STR-29).

---

## Support Window

**6 months of active maintenance** from the date of the v1.0.0 Apache 2.0
release (target: end of Milestone 3). During this window:

- **Security fixes** for Critical and High severity issues
- **Bug fixes** for regressions and material correctness issues
- **CIP-103 / CIP-56 conformance updates** as the Canton standards evolve
- **CIP-0112 V1→V2 migration support** as CC, USDCx, and other assets
  publish V2 interfaces
- **V2 stabilization tracking** as `splice@token-standard-v2-upcoming`
  graduates to a stable release

The 6-month window may be extended via a follow-on Canton Foundation
grant if there is demonstrated ecosystem adoption (per the Milestone 5
adoption-bonus metrics).

After the window closes, the v1.x release line enters **community
maintenance**: pull requests are reviewed and merged, but the original
team does not actively fix issues. Adopters are encouraged to upgrade to
later major versions as they ship.

---

## Security Patch SLA

| Severity | Definition | First-response SLA | Patch SLA |
|---|---|---|---|
| **Critical** | Loss of funds; signature bypass; ability to spend assets without authorization | 24 hours | **72 hours** |
| **High** | Privilege escalation; bypass of `DelegatedPolicy` bounds; ability to drain a stream's escrow without authorization; bypass of CIP-103 wallet signing | 48 hours | **2 weeks** |
| **Medium** | Information disclosure; denial of service against the proxy / dashboard; off-by-one accrual at boundary times | 1 week | **30 days** |
| **Low** | Cosmetic, documentation, dev-mode only | Best-effort | Next minor release |

**Out-of-band patches** for Critical issues will be tagged as
`v1.x.y-security` and announced via:

1. GitHub Security Advisories (private then public)
2. `SECURITY.md` Hall of Fame for the reporter (if they consent)
3. Co-Marketing announcement coordinated with the Canton Foundation if
   the issue is severe enough to warrant ecosystem-wide notice

---

## Reporting Security Issues

**Do not** open a public GitHub issue for security reports.

Email: `security@canton-streams.example` (replace with actual mailbox at
v1.0.0 release time; current placeholder).

PGP key fingerprint will be published in `SECURITY.md` and on the
release page.

We accept reports in:

- English
- Reproducible test cases (Daml-script preferred where possible)
- Threat models with specific contract IDs / template IDs
- Working exploits (optional but appreciated for severity calibration)

### Disclosure Timeline

1. **Day 0**: Reporter sends private report
2. **Day 0-2**: Triage + severity assignment + acknowledgement to reporter
3. **Day 2-N**: Fix developed + tested against the audit baseline
4. **Day N+1**: Fix merged behind a security-advisory placeholder
5. **Day N+30 (or sooner for Critical)**: Coordinated disclosure with
   reporter + Canton Foundation; public GitHub Security Advisory; CVE
   requested if applicable

---

## Versioning Policy

Canton Payment Streams follows **Semantic Versioning 2.0.0** within the
v1.x release line:

- **Major (v2.0.0)**: Breaking changes to on-ledger Daml templates,
  breaking SDK API changes, or breaking CIP conformance changes.
  Migration path published in `CHANGELOG.md` with at least one minor
  version of deprecation notice on the preceding line.
- **Minor (v1.x.0)**: New features, new Daml templates, new SDK methods,
  new docs. Backwards-compatible.
- **Patch (v1.x.y)**: Bug fixes, security patches, doc clarifications.
  Backwards-compatible.

**LTS commitment**: v1.x is the LTS line during the 6-month support
window. v1.0 → v1.x patch upgrades will never require a Daml DAR
upgrade unless the patch is a security fix marked `(security-required)`
in `CHANGELOG.md`.

**Pre-1.0**: not supported. Any 0.x DAR or SDK in the wild should be
upgraded to v1.0.0 or later.

---

## V2 Token Standard Migration

Per CIP-0112, the V2 token standard is designed for dual-interface
coexistence with V1. The library's behavior across V1 → V2 transitions:

1. **Assets advertising V1 only** — library uses `TokenStandardAdapter`
   (V1) and existing flows continue to work indefinitely. No action
   required by adopters.
2. **Assets advertising V1 + V2** — library automatically prefers V2 via
   `getAssetCapabilities` (per CIP-0112 § 5). Adopters see V2 features
   (lock-in-place custody, multi-leg allocations, event-driven
   advancement) light up without code changes once `config/asset-registry.json`
   is updated for that asset.
3. **Assets advertising V2 only** — library uses `TokenStandardV2Adapter`
   exclusively. V1-only streams against these assets are not possible.

The library will track the `splice@token-standard-v2-upcoming` branch
during V2 stabilization and align with the stable V2 release once
published. Breaking changes in the V2 preview branch will be surfaced
in `CHANGELOG.md` and treated as patch-level updates until V2 stable.

---

## CIP-103 dApp API Stability

CIP-103 is the foundational architectural choice for end-user dApp
flows. The library's CIP-103 Provider implementation will track the
official OpenRPC contract published in `splice-wallet-kernel`. Breaking
changes in the CIP-103 spec during the 6-month window will be:

- Tracked in `CHANGELOG.md`
- Released as minor versions until CIP-103 reaches 1.0.0
- Validated against the official OpenRPC conformance suite before each
  release (STR-36)

---

## Channels

| Channel | Purpose |
|---|---|
| **GitHub Issues** | Bug reports, feature requests, documentation feedback |
| **GitHub Security Advisories** | Coordinated security disclosure (private until patched) |
| **GitHub Discussions** | Architecture, design questions, ecosystem conversations |
| **Canton Foundation Discord / Slack** | Real-time community support |
| **`security@canton-streams.example`** | Private security reports only |

---

## Out of Scope

This maintenance window covers the library itself. It does **not**
cover:

- Customer-deployed infrastructure (proxy hosts, dashboards, executor
  services) — operated by adopters under their own SLAs
- The wallet-gateway service — operated by validators / SVs
- Third-party CIP-103 wallet implementations — operated by their authors
- The Canton Network itself, including SV-side scan endpoints — operated
  by the Canton Foundation and validators
- Custom forks of Canton Payment Streams — fork maintainers are
  responsible for their forks

---

## Acceptance and Renewal

This commitment is published at the v1.0.0 release. Renewal of the
support window beyond the initial 6 months is contingent on:

1. Demonstrated ecosystem adoption (≥5 featured apps active per M4
   acceptance, with ≥3 active by month 6 of the support window)
2. Foundation alignment on a follow-on grant or community maintenance
   model
3. Continued strategic relevance of the library to the Canton ecosystem

If renewal is not pursued, this maintenance window enters a 30-day wind-
down at the end of month 6 with one final patch release containing any
outstanding security fixes and a `MAINTENANCE-STATUS.md` document
formally declaring community maintenance.
