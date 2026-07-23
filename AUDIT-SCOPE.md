# Security review — scope

This document states the boundary of the internal security review of Canton
Payment Streams: what was examined, how, and what was explicitly out of scope.
It accompanies [`SECURITY-FINDINGS.md`](./SECURITY-FINDINGS.md), which lists the
findings and their status.

## Asset at risk

Canton Coin (Amulet, "CC") on the Splice / Amulet **TestNet**. No mainnet
deployment exists. Amounts are test funds.

## What was reviewed

The review targeted the settlement redesign and every path that moves value or
makes an authorization decision:

- **Escrow custody lane** — the "deposit once, operator streams" flow: deposit
  intake, the per-cycle release streamer, refund, and the on-ledger
  `OperatorEscrow` record. This is the only custodial surface and received the
  most attention.
- **Direct / mandate lane** — per-cycle transfers and the `StreamMandate`
  authorization model, including how the money leg is submitted.
- **Settlement recording** — the paths that accept a client-supplied on-chain
  `updateId` and record a settled/claimed/accepted cycle, and how they verify
  it against the global Scan.
- **Daml templates** — the escrow/stream templates and their choice guards
  (renewal, completion, cancellation, iterated settlement caps), the operator
  index templates, the mandate, and the delegated-execution policy.
- **Proxy authorization + transport** — request auth, the dev-auth posture,
  rate limiting, bind host, and error handling.
- **Dashboard fund-touching flows** — wallet-signed deposit, recipient
  auto-accept, and the labels that describe custody/verification state.
- **Infrastructure** — the reverse-proxy config and container compose file
  (headers, published ports, bind hosts).

## Topology assumptions

The intended production topology hosts the **payer and receiver on their own
participants**, with the operator (escrow custodian) on a separate participant.
The current test environment co-hosts parties on a single participant for
convenience; several trust properties depend on the production topology and are
called out where relevant in the findings.

## Method

- Source reading and manual data-flow tracing across the Daml, proxy, and
  dashboard layers.
- Arithmetic reproduction of the accrual / settlement math.
- Daml-script regression tests for the ledger-enforced invariants.
- Validation of the on-chain settlement decoder against real committed updates
  read from the network.

This is an **internal** review. It is **not** a third-party audit and did not
perform live exploitation against the running system. A full external audit is
planned before any mainnet deployment.

## Out of scope

- The upstream Splice / Amulet DARs and the Canton protocol itself.
- The internal implementation of external wallet gateways.
- Formal verification and third-party penetration testing.
- Economic / incentive design of the streaming product.

## Environment notes

Party identifiers, host addresses, and operator/DSO party fingerprints are
omitted from this document and from the findings register. Deployment secrets
are held only in the operator's environment and never appear in the repository.
