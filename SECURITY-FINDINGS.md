# Security findings

Findings from the internal review described in [`AUDIT-SCOPE.md`](./AUDIT-SCOPE.md),
with severity, current status, and the control that addresses each. Exploit
inputs, party identifiers, host addresses, and secrets are intentionally
omitted — this register describes vulnerability *classes* and their mitigations,
not reproduction steps against the live system.

## Status legend

- **Fixed (live)** — corrected in the proxy and/or dashboard and deployed to the
  TestNet environment.
- **Fixed (Daml, pending re-vet)** — corrected in the `canton-streams` Daml
  source; takes on-ledger effect after a versioned DAR rebuild + re-vet on the
  validator. Several of these apply to templates not on the current live money
  path.
- **Resolved by topology** — no longer a defect once the intended production
  topology is used; documented in the code.
- **Residual** — an accepted, documented limitation with a compensating control
  and a stronger future form.

## Critical

| ID | Title | Status | Control |
|----|-------|--------|---------|
| C1 | Escrow deposit trusted without on-chain verification | Fixed (live) | The deposit is structurally decoded from the committed Scan update and must move the configured CC from the payer to the escrow party for at least the requested amount; the funded total is taken from the **verified on-chain amount**, and each funding id may back at most one escrow. A fabricated or too-small deposit reference can no longer create a funded escrow. |

## High

| ID | Title | Status | Control |
|----|-------|--------|---------|
| H1 | Escrow release off-schedule / triggerable by the recipient | Fixed (live) | Manual release is payer-only and cadence-gated; a pre-release **solvency interlock** refuses any release or refund that would leave the shared custody party unable to cover every active escrow's remaining. Every store mutation is serialized across processes by a single-writer lock (so a second instance or a redeploy overlap cannot race a double release), and a continuous monitor alerts on any drift between the custody balance and the total owed. |
| H2 | Settlement bound to a stream by a weak text match; client amount trusted | Fixed (live) | Every recording path structurally decodes the committed update and credits the **on-chain** amount. A direct settle binds both parties, the instrument, the amount, and the stream's own agreement tag. An accept or claim binds the exact offer contract — the update must **consume** it (exercise/archive, not merely reference) and create a holding for the recipient of at least the tracked amount, so the offer's own creation update can't be replayed as its acceptance; a withdraw likewise requires the offer be consumed and credits nothing. An update backs at most one recorded cycle across all streams, and a payer may not stream to itself. |
| H3 | Mandate/direct model advertised as non-custodial but not enforced under co-hosting | Reclassified Medium (conditional) — see M5 | In the production topology the payer is on its own participant, so Canton enforces the property on-ledger, and the proxy now refuses an operator-authority submission of a co-hosted party's funds unless custody is explicitly disclosed. Two conditions remain (M5): the property is enforced but the on-ledger pull path is not yet wired, and the disclosure is operator-self-asserted. |
| H4 | Renewal could re-price the vesting curve below already-accrued value | Fixed (Daml, pending re-vet) | A renewal may not price the curve below the recipient's accrued amount; enforced by an on-ledger invariant with a regression test. |
| H5 | Loopback bind validated but not applied; dashboard network-exposed | Fixed (live) | The bind host is passed to the listener; the container compose publishes the dashboard to loopback by default. |

## Medium

| ID | Title | Status | Control |
|----|-------|--------|---------|
| M1 | Weak revocation + settle/stop race | Fixed (live) | Revocation toggles on-ledger state; stop and settle are serialized so a stop cannot be raced; an explicit settle amount is clamped to what has accrued. |
| M2 | On-chain update replayable across a payer's other streams | Fixed (live) | A store-global check ensures one update backs at most one cycle. |
| M3 | Escrow inputs bypass validation; non-atomic store | Fixed (live) | Every escrow input is validated before any transfer; the store is written atomically and a corrupt store fails loud instead of being overwritten. |
| M4 | Rate limiter keyed on the proxy's own address | Fixed (live) | Opt-in, bounded reverse-proxy trust so the limiter keys on the real client. |
| M5 | Co-hosting silently makes the "non-custodial" lanes custodial (was H3) | Enforced (live), conditional | The one operator-authority money-leg submission refuses a party hosted on the operator's participant unless the deployment sets a disclosed-custody flag, so a co-hosting misconfiguration is caught rather than quietly custodial. Conditions kept on the register: **(a)** the flag is operator-self-asserted (a disclosure, not a defence against a malicious operator, who controls the flag and the participant); **(b)** in the genuinely non-custodial topology the trust-minimised on-ledger pull is not yet wired, so that lane is custody-safe but feature-incomplete until it is — see the design doc's build status. |

## Low

Addressed across the proxy, dashboard, and Daml layers (Daml items pending
re-vet):

- On-ledger index cycles bounded by the rate and de-duplicated; the audit log
  requires joint authorization to prune; an observer-visibility caution added.
- Reconcile no longer infers delivery it cannot confirm, and does not expose the
  aggregate custody balance to a single stakeholder.
- Dev fallback token only issued under an explicit dev-auth acknowledgment; the
  dev bearer token moved to per-tab session storage; misleading "not a
  credential" wording corrected.
- Dashboard custody/verification labels reworded to reflect what is actually
  proven ("operator-reported" rather than "verified on-chain").
- Reverse proxy sets HSTS and a Content-Security-Policy.
- Recipient auto-accept verifies any gateway-echoed action/contract id before
  signing; the wallet deposit is checked to act as the payer and target the
  escrow party before signing.
- Non-finite amounts and control-character inputs rejected at the escrow
  boundary.
- Fail-closed default for the dev-auth token selection.

## Informational

- Release audit entries record the actual initiating party.
- The operator index template carries a design-note caution about exposing
  operator-written totals to the payee before those totals are bound to verified
  transfers.

## Residuals and follow-ups

- **Commingled custody — accepted operator-custodial residual, with conditions.**
  Escrow deposits share one operator custody party, and the model is disclosed as
  operator-custodial in the UI and headers: the operator holding the funds is
  within the trust model, not a defect. The layered controls make one escrow
  unable to spend another's funds and bound the damage a fault can do:
  - Deposits are verified on-chain and the funded total is the verified amount.
  - Release is payer-only, cadence-gated, and bounded per escrow.
  - A pre-release **solvency interlock** refuses any move that would leave the
    custody party unable to cover every active escrow's remaining.
  - An **aggregate cap** bounds the total obligation the single key is ever
    trusted with.
  - A **single-writer lock** serializes every store mutation across processes.
  - A **continuous monitor** alerts on custody-vs-owed drift.

  The precise boundary kept on the register: these are proxy-level and on-ledger
  bookkeeping controls, so the sole protection against outright theft remains the
  **operator key** — the deposits are free holdings under one party, movable by any
  code path that holds the key. Conditions before this custodies value that
  matters: HSM / threshold key custody with a hard aggregate cap bounding the
  blast radius; a cross-host distributed lock if the proxy is ever run with more
  than one writer (the current lock is single-host); and, as the stronger future
  form, literal per-escrow isolation (a distinct party per escrow or an on-ledger
  asset lock), which needs per-escrow participant infrastructure or settlement
  rights not available on this network.
- **DAR re-vet.** The Daml invariant changes are in `canton-streams` source; a
  versioned rebuild + re-vet on the validator is required for them to take
  on-ledger effect. The deployed proxy already feeds these paths verified,
  bounded inputs.
- **Live decoder validation.** The structural settlement decoder was validated
  against real committed updates from the network; a broader live smoke test is
  recommended as additional instruments and flows are enabled.
- **External audit.** No third-party audit has been performed; one is planned
  before any mainnet deployment.
