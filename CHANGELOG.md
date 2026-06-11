# Changelog

All notable changes to Canton Payment Streams are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Transitional CIP-56 V1 settlement lane** (`splice-api-token-allocation-v1`) so MainNet-live assets (CC/Amulet, USDCx) settle streams before CIP-0112 ratifies: self-contained SDK builders (`commands/allocation-v1.ts`), `dispatchSettlementV1` + lane-aware capability gating (`resolveSettlementVersion`; iterated/batch stay V2-only), registry `allocationsV1` flag, disclosed-contract support in both transports, registry choice-context fetcher (`settlement/choice-context.ts`), separate `canton-streams-v1-shim` DAR, and `scripts/devnet-v1-cc-stream-probe.mjs`. **Field-validated with real CC on TestNet and MainNet (2026-06-10)** — see `docs/reports/`. **Retirement plan ("V1 lane retirement")**: when CC/USDCx advertise V2, flip registry flags, delete the `*-v1` SDK/test files + `choice-context.ts` + the dispatcher's V1 section + the v1-shim package + the probe, and drop the V1 entries from `check-v2-conformance.sh` ALLOWED_FILES.
- **Attribution metadata stamping** on every settlement's public asset leg: `cantonstreams.dev/{ref,v,app,agreement}` (app via `CANTON_STREAMS_APP_ID`, agreement via `CANTON_STREAMS_AGREEMENT_ID` or params). Committee-grade collector `scripts/scan-usage-report.mjs`: incremental cursor (`STATE_FILE`), synchronizer-**migration-aware** paging, per-app + per-agreement rollups, integrator registry + affiliate exclusion, imputed traffic/burn columns (per-tx cost measured on MainNet: 19,122 bytes/settlement). Integrator guide: `docs/integration-guide/streams-integration.md`.
- **Recipient pre-flight** (`checkRecipientDeliverability`): registry probe telling operators whether a recipient delivers hands-free (`direct`, has TransferPreapproval) or needs onboarding (`offer`) — no on-ledger submission.
- **Interest-stream scheduler** (`scripts/interest-stream-scheduler.mjs`): reference daemon for fixed-rate recurring payouts (e.g. CIP-0105 token-lock interest) — hourly/daily cadence, Stepped accrual with per-agreement arrears policy (`catch-up` settles accumulated windows after an outage; `skip-missed` caps at one period), MainNet-validated transfer-instruction settlement with full attribution stamping, optional `Sync_Iteration` recording, durable state, `DRY_RUN`/`ONCE` modes.

## [0.2.8] - 2026-05-23

### Changed

- **V2-only pivot.** Removed all V1/V0 Daml stubs (`StreamEscrow`, `UtilityHoldingEscrow`, `LocalAssetEscrow`, `CreateUtilityHoldingStream`, etc.) and their SDK wrappers. The single supported settlement path is now CIP-56 V2 Token Standard via the CIP-0112 `AllocationRequest` pattern. The `SettlementMode` enum retains the legacy names for backwards compatibility with persisted requests, but only `TokenStandardCustody` is exercised by the live code path.
- **AllocationRequest V2 migration.** Stream-admin templates (`StreamAdmin`, `StreamFlow` + `StreamFlowAdmin`, `MilestoneAdmin`) now expose the V2 `AllocationRequest` shape. The shared view-builder helpers live in `Settlement.AllocationBridge`.
- **Dashboard auth: CIP-103 wallet flow.** The dashboard now uses `@canton-network/dapp-sdk` for end-user authentication; JWT-paste remains as a dev fallback only. The proxy reads identity from the JWT `party`/`sub` claim and no longer requires the `X-Canton-Party` header from browser clients.
- **Auto-withdraw rewritten** as an event-driven `TransferEventsV2` subscriber (`packages/proxy/src/transfer-events-subscriber.ts`), replacing the poll-based path. Falls back to interactive submission when a participant cannot stream the event directly.
- **Per-asset registry** (`config/asset-registry.json`) drives V2 capability gating. The SDK call `getAssetCapabilities(instrumentRef)` reads the registry; library rejects assets without required V2 allocation support, with no per-asset branching in application code.
- **CC and USDCx run through the same code path.** Both validated end-to-end on TestNet via the same SDK shape; only the registry entry differs.

### Added

- **Wallet-backed E2E harness docs** (`docs/E2E-HARNESS.md`) — local CIP-103 wallet wiring and live V2 flow validation guidance.
- **`scripts/check-tunnel.sh`** — watchdog that detects when a local Canton sandbox is shadowing an SSH-tunnel port and would route gRPC to the wrong ledger.
- **`VITE_SKIP_WALLET_PICKER`** dashboard env flag — auto-selects the configured remote wallet without showing the picker UI (for single-wallet dev environments).
- **Opt-in `FeaturedAppActivityMarker` emission helper** for networks that still support the CIP-0047 marker path. Treat the helper as transitional and don't bake CIP-0047 reward amounts into adopter economics.
- **CIP-103 OpenRPC conformance harness** (`packages/sdk/src/cip103/*.test.ts`) — exercises the dapp/wallet JSON-RPC contract without requiring a browser.
- **Multi-Scan adoption-metrics aggregator** (`scripts/query-adoption-metrics.mjs`) — aggregates across per-asset Scan endpoints.
- **OSS-readiness pass**: cleaned organization-specific names from defaults, removed scratch debug scripts, added per-package `repository`/`homepage`/`bugs` URLs, added `packages/dashboard/.env.example`.

### Removed

- All V1/V0 settlement Daml stubs and their SDK adapters.
- Approx. 24 one-off operator scratch scripts from `packages/sdk/*.ts` root.
- Hardcoded organization-specific registrar prefixes and instrument-id defaults from the SDK source.
- Internal planning docs and audit-report drafts that should not ship publicly.

### Migration notes

Users on `0.2.7` or earlier that consumed `NumericLegacy` / `UtilityHoldingCustody` / `LocalAssetCustody` settlement modes must migrate to `TokenStandardCustody` before upgrading. The on-ledger upgrade is non-trivial — open an issue if your deployment needs migration assistance.

## [0.2.7] - 2026-04-01

### Added
- Native `CC` / `Amulet` settlement orchestration through the shared token-standard adapter path.
- Open-source governance docs: `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `RELEASING.md`.
- A tag-driven GitHub Actions release workflow for the npm packages (`sdk-vX.Y.Z` and `cli-vX.Y.Z`).

### Changed
- Aligned the workspace release line to `0.2.7` across the TypeScript packages and root manifest.
- Updated the Daml test/script packages to reference the current DAR filenames instead of stale `0.1.0` artifacts.
- Expanded the README integration guide so third-party Canton apps can provision identities, vet DARs, and wire settlement flows without missing hidden steps.

### Fixed
- Removed the stray `packages/sdk/package-lock.json` so the workspace no longer mixes pnpm and npm lockfiles.
- Tightened package metadata for publishable packages with explicit Node engine support, public publish config, and discoverability keywords.

## [0.2.5] - 2026-03-19

### Fixed
- **Critical: Daml LF rounding parity** — `accrual/calculator.ts` and proxy withdraw auto-compute
  now use `ROUND_HALF_EVEN` (banker's rounding) with 10 decimal places to match Daml LF's Java
  BigDecimal behavior. Previous `ROUND_DOWN` caused `Withdraw_TokenStandard` and
  `MutualCancel_TokenStandard` assertion failures whenever the accrual fraction was ≥ 0.5.
- **Arithmetic order in proxy** — withdraw auto-compute now evaluates `totalDeposited * elapsed / duration`
  (multiplication before division) matching Daml's left-to-right expression evaluation.
- **`cancelTime` propagation** — added `cancelTime?: Date` to `TokenStandardCancelParams`; SDK `cancel`
  and `mutualCancel` commands now use the caller-supplied timestamp instead of `Date.now()`, ensuring
  the Daml accrual assertion uses the exact moment the caller computed settlement amounts.
- **API.md corrections** — fixed withdraw response fields (`amountWithdrawn`/`newTotalWithdrawn`/
  `newStatus`), mutual-cancel `recipientToken` field, error response `reason` field, and stream filter
  query parameters.

## [0.2.4] - 2026-03-18

### Added
- Release documentation: README, QUICKSTART, DEPLOYMENT, ARCHITECTURE, API reference, CONTRIBUTING guide
- Production JWT auth mode with OIDC/JWKS verification (`PROXY_AUTH_MODE=jwt`)
- JSON API browser transport (`JsonApiTransport`) for direct browser-to-ledger access
- Generic local-asset custody via Daml Finance `Fungible.I`/`Transferable.I` interfaces
- Template registry (`templates.ts`) with environment-configurable package IDs
- Settlement mode dispatch in SDK commands (NumericLegacy, UtilityHoldingCustody, LocalAssetCustody)
- `SettlementMode` enum and `EscrowOperatorRef` type
- Choice name constants for all settlement modes
- `ESCROW_TEMPLATES` and `CREATE_REQUEST_TEMPLATES` template groups
- Ledger-sourced event history via UpdateService (replaces synthetic placeholders)
- SessionStorage auth persistence across page refreshes
- Staggered query invalidation for read-after-write consistency
- TokenStandardCustody withdraw orchestration: proxy auto-executes transfer + on-ledger settlement
- Mutual cancel orchestration: proxy auto-executes both transfer legs for TokenStandardCustody

### Fixed
- History feed now returns real ledger events with `source: "ledger"` instead of synthetic estimates
- `decodeHistoryValue()` handles top-level gRPC record format from UpdateService
- Auth state preserved on deep links and hard refresh
- Read-after-write staleness resolved with staggered cache invalidation

## [0.2.0] - 2026-02

### Added
- Settlement type scaffolding: `SettlementMode`, `HoldingFunding`, `InstrumentRef`
- Utility holding custody Daml templates (escrow, workflow, adapter)
- `HoldingAdapter.daml` for generic Daml Finance `Fungible.I`/`Transferable.I` operations
- Batch stream creation (`BatchCreateRequest`)
- Stream renewal support (`Renew_Stream` choice)
- Delegated policy templates
- Dashboard pending requests panel

## [0.1.0] - 2026-01

### Added
- Initial numeric bookkeeping escrow implementation
- `StreamEscrow` and `CreateStreamRequest` Daml templates
- TypeScript SDK with gRPC transport
- Express REST proxy with dev auth mode
- React dashboard with stream list, create form, detail view
- Linear, cliff, and stepped vesting modes
- Stream cancellation and mutual cancellation
- Accrual calculator and real-time balance ticker
- Docker Compose setup (Canton sandbox + dashboard)
