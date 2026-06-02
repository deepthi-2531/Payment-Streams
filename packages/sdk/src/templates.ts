/**
 * Centralized template registry for Canton Streams.
 *
 * All template IDs are defined here, eliminating duplication across command
 * files and providing a single place to update when DARs are redeployed.
 *
 * Package references are read from environment variables with stable
 * package-name fallbacks for local dev. Canton 3.4 resolves package names
 * on template identifiers; explicit package hashes can still be supplied
 * by deployment environments that pin vetted DARs.
 *
 * @module templates
 */

import type { TemplateId } from './transport/base.js';
import { SettlementMode } from './types/stream.js';

// ---------------------------------------------------------------------------
// Package references — configurable via environment
// ---------------------------------------------------------------------------

const DEFAULT_STREAMS_PACKAGE_REF = 'canton-streams';

/**
 * Main Canton Streams package reference (name by default, hash when pinned).
 * Override: CANTON_STREAMS_PACKAGE_ID
 */
const MAIN_PACKAGE_ID: string =
  process.env['CANTON_STREAMS_PACKAGE_ID'] ?? DEFAULT_STREAMS_PACKAGE_REF;

/**
 * Utility/CIP custody package reference (Phase 2 — utility holding escrow + workflows).
 * Override: CANTON_STREAMS_UTILITY_PACKAGE_ID
 *
 * Set this when the utility holding custody DAR is deployed in a separate package
 * from the main streams DAR. Defaults to MAIN_PACKAGE_ID for local dev.
 */
const UTILITY_PACKAGE_ID: string =
  process.env['CANTON_STREAMS_UTILITY_PACKAGE_ID'] ?? MAIN_PACKAGE_ID;

/**
 * Token-standard custody package reference (Phase 2 — externally funded escrow).
 * Override: CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID
 *
 * On deployments where TokenStandardEscrow and its workflow templates are in
 * a separate DAR from the main streams package (e.g. testnet/devnet with
 * incremental DAR uploads), set this to the correct package reference.
 *
 * Example override:
 *   export CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID="<package-name-or-hash>"
 *
 * Defaults to MAIN_PACKAGE_ID for local dev (where TokenStandard is in the main DAR).
 */
const TOKEN_STANDARD_PACKAGE_ID: string =
  process.env['CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID'] ?? MAIN_PACKAGE_ID;

/**
 * Local asset custody package reference (Phase 2 — AMM AssetHolding escrow).
 * Override: CANTON_STREAMS_LOCAL_ASSET_PACKAGE_ID
 */
const LOCAL_ASSET_PACKAGE_ID: string =
  process.env['CANTON_STREAMS_LOCAL_ASSET_PACKAGE_ID'] ?? MAIN_PACKAGE_ID;

/**
 * Phase 3 policy package reference.
 * Override: CANTON_STREAMS_POLICY_PACKAGE_ID
 *
 * Some environments deploy the policy modules in a separate DAR from the
 * main stream package. Falling back to MAIN_PACKAGE_ID keeps local dev simple
 * while allowing devnet/mainnet-style deployments to point at the correct DAR.
 */
const POLICY_PACKAGE_ID: string =
  process.env['CANTON_STREAMS_POLICY_PACKAGE_ID'] ?? MAIN_PACKAGE_ID;

// ---------------------------------------------------------------------------
// Phase 1 — Numeric Escrow templates
// ---------------------------------------------------------------------------

/** CreateStreamRequest — sender proposes a new payment stream. */
export const TEMPLATE_CREATE_REQUEST: TemplateId = {
  packageId: MAIN_PACKAGE_ID,
  moduleName: 'CantonStreams.Workflow.CreateStream',
  entityName: 'CreateStreamRequest',
};

/** BatchCreateRequest — sender proposes multiple streams atomically. */
export const TEMPLATE_BATCH_REQUEST: TemplateId = {
  packageId: MAIN_PACKAGE_ID,
  moduleName: 'CantonStreams.Workflow.BatchCreate',
  entityName: 'BatchCreateRequest',
};

/** StreamEscrow — active numeric escrow (Phase 1). */
export const TEMPLATE_STREAM_ESCROW: TemplateId = {
  packageId: MAIN_PACKAGE_ID,
  moduleName: 'CantonStreams.Stream.Escrow',
  entityName: 'StreamEscrow',
};

// ---------------------------------------------------------------------------
// V2-only admin/observability template (STR-86)
// ---------------------------------------------------------------------------

/**
 * StreamAdmin — V2-only admin/observability template per STR-86.
 *
 * Records stream metadata + pointers to the active V2 `Allocation` cid
 * in the iteration chain. Real custody lives in the V2 `Allocation`
 * contract created by the sender via `AllocationFactory_Allocate`;
 * this template holds the per-stream observability surface
 * (`Sync_Iteration`, `Mark_Cancelled`, `Mark_Completed`).
 */
export const TEMPLATE_STREAM_ADMIN: TemplateId = {
  packageId: MAIN_PACKAGE_ID,
  moduleName: 'CantonStreams.Stream.StreamAdmin',
  entityName: 'StreamAdmin',
};

/** Choices on StreamAdmin (V2-only per STR-86). */
export const CHOICE_SYNC_ITERATION = 'Sync_Iteration';
export const CHOICE_MARK_CANCELLED = 'Mark_Cancelled';
export const CHOICE_MARK_COMPLETED = 'Mark_Completed';
export const CHOICE_GET_STREAM_ADMIN_INFO = 'GetStreamAdminInfo';

// ---------------------------------------------------------------------------
// Phase 2 — Utility/CIP Holding Custody templates
// ---------------------------------------------------------------------------

/**
 * CreateUtilityHoldingStreamRequest — sender proposes a utility-holding-backed stream.
 * Carries fundingHoldingCid, instrumentRef, recipientAccount.
 */
export const TEMPLATE_UTILITY_CREATE_REQUEST: TemplateId = {
  packageId: UTILITY_PACKAGE_ID,
  moduleName: 'CantonStreams.Workflow.CreateUtilityHoldingStream',
  entityName: 'CreateUtilityHoldingStreamRequest',
};

/**
 * AcceptedUtilityHoldingRequest — intermediate state after recipient accepts.
 * Service finalizes custody from this contract.
 */
export const TEMPLATE_UTILITY_ACCEPTED_REQUEST: TemplateId = {
  packageId: UTILITY_PACKAGE_ID,
  moduleName: 'CantonStreams.Workflow.CreateUtilityHoldingStream',
  entityName: 'AcceptedUtilityHoldingRequest',
};

/** UtilityHoldingEscrow — active custody-backed escrow (Phase 2). */
export const TEMPLATE_UTILITY_ESCROW: TemplateId = {
  packageId: UTILITY_PACKAGE_ID,
  moduleName: 'CantonStreams.Stream.UtilityHoldingEscrow',
  entityName: 'UtilityHoldingEscrow',
};

// ---------------------------------------------------------------------------
// Phase 2 — Token-standard external custody templates
// ---------------------------------------------------------------------------
//
// [C1 fix — STR-103] These template ids reference Daml templates that
// DO NOT EXIST in the current canton-streams package:
//
//   - CantonStreams.Workflow.CreateTokenStandardStream (module missing)
//   - CantonStreams.Stream.TokenStandardEscrow (module missing)
//
// Confirmed by `ls packages/daml/main/daml/CantonStreams/Stream/` (no
// TokenStandardEscrow.daml) and `ls .../Workflow/` (no CreateTokenStandard*).
// Likely cause: the templates were folded into the dual-interface
// StreamEscrow under STR-66 but the SDK + proxy weren't updated.
//
// Per the STR-79 cutover umbrella, the TokenStandardCustody path is
// migrating to the standard AllocationRequest flow via the dual-interface
// StreamEscrow (STR-86). Until that lands, any code that exercises these
// templates will fail at the ledger with "template not found".
//
// To prevent silent failure at submit time:
//   - The constants below are retained as exports so existing
//     dependents compile, but they're tagged @deprecated.
//   - At runtime, the per-mode dispatch in commands/withdraw.ts +
//     proxy/auto-withdraw.ts MUST refuse to submit against these template
//     ids until the migration completes. See `assertTokenStandardEscrowAvailable`
//     below.
//
// When STR-86 lands the standard-driven lifecycle on StreamEscrow, these
// constants are deleted and SDK consumers are redirected to
// TEMPLATE_STREAM_ESCROW with settlementMode=TokenStandardCustody.

/**
 * @deprecated TokenStandardEscrow Daml template does not exist in the
 * current package. See STR-103. Code paths that depend on this constant
 * must fail closed; do not submit against this template id until STR-86
 * lands the AllocationRequest-driven lifecycle. Prefer TEMPLATE_STREAM_ESCROW
 * with settlementMode=TokenStandardCustody when STR-86 ships.
 */
export const TEMPLATE_TOKEN_STANDARD_CREATE_REQUEST: TemplateId = {
  packageId: TOKEN_STANDARD_PACKAGE_ID,
  moduleName: 'CantonStreams.Workflow.CreateTokenStandardStream',
  entityName: 'CreateTokenStandardStreamRequest',
};

/**
 * @deprecated See TEMPLATE_TOKEN_STANDARD_CREATE_REQUEST. Daml template missing.
 */
export const TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST: TemplateId = {
  packageId: TOKEN_STANDARD_PACKAGE_ID,
  moduleName: 'CantonStreams.Workflow.CreateTokenStandardStream',
  entityName: 'AcceptedTokenStandardStreamRequest',
};

/**
 * @deprecated See TEMPLATE_TOKEN_STANDARD_CREATE_REQUEST. Daml template missing.
 */
export const TEMPLATE_TOKEN_STANDARD_ESCROW: TemplateId = {
  packageId: TOKEN_STANDARD_PACKAGE_ID,
  moduleName: 'CantonStreams.Stream.TokenStandardEscrow',
  entityName: 'TokenStandardEscrow',
};

/**
 * [C1 fix — STR-103] Runtime guard. Call before any submit that targets
 * the TokenStandardEscrow templates. Throws a clear error pointing at
 * the migration ticket so the failure mode is loud, not "template not found".
 *
 * The guard reads env `CANTON_STREAMS_TOKEN_STANDARD_ESCROW_PRESENT=true`
 * to override after the operator confirms the template exists in their
 * deployment (e.g. a fork that ships the missing template). Defaults to
 * fail-closed.
 */
export function assertTokenStandardEscrowAvailable(): void {
  if (process.env['CANTON_STREAMS_TOKEN_STANDARD_ESCROW_PRESENT'] === 'true') {
    return;
  }
  throw new Error(
    '[STR-103] TokenStandardEscrow Daml template is NOT present in the canton-streams package. ' +
      'The SDK + proxy reference it but the Daml module was never published (likely folded into ' +
      'StreamEscrow under STR-66). Any submit against this template will fail at the ledger. ' +
      'Use the V2 AllocationRequest + StreamAdmin path instead. Override with ' +
      'CANTON_STREAMS_TOKEN_STANDARD_ESCROW_PRESENT=true only if your deployment includes the template.',
  );
}

// ---------------------------------------------------------------------------
// Phase 2 — Local Asset Custody templates (spike-first)
// ---------------------------------------------------------------------------

/** CreateLocalAssetStreamRequest — sender proposes a local-asset-backed stream. */
export const TEMPLATE_LOCAL_ASSET_CREATE_REQUEST: TemplateId = {
  packageId: LOCAL_ASSET_PACKAGE_ID,
  moduleName: 'CantonStreams.Workflow.CreateLocalAssetStream',
  entityName: 'CreateLocalAssetStreamRequest',
};

/**
 * AcceptedLocalAssetRequest — intermediate state after recipient accepts.
 * Service finalizes custody from this contract.
 */
export const TEMPLATE_LOCAL_ASSET_ACCEPTED_REQUEST: TemplateId = {
  packageId: LOCAL_ASSET_PACKAGE_ID,
  moduleName: 'CantonStreams.Workflow.CreateLocalAssetStream',
  entityName: 'AcceptedLocalAssetRequest',
};

/** LocalAssetEscrow — active local-asset custody escrow. */
export const TEMPLATE_LOCAL_ASSET_ESCROW: TemplateId = {
  packageId: LOCAL_ASSET_PACKAGE_ID,
  moduleName: 'CantonStreams.Stream.LocalAssetEscrow',
  entityName: 'LocalAssetEscrow',
};

// ---------------------------------------------------------------------------
// Phase 3 — Delegated Execution templates
// ---------------------------------------------------------------------------

/** DelegatedPolicy — sender delegates execution rights to an executor. */
export const TEMPLATE_DELEGATED_POLICY: TemplateId = {
  packageId: POLICY_PACKAGE_ID,
  moduleName: 'CantonStreams.Policy.DelegatedPolicy',
  entityName: 'DelegatedPolicy',
};

/** ExecutionLog — immutable audit trail per delegated execution. */
export const TEMPLATE_EXECUTION_LOG: TemplateId = {
  packageId: POLICY_PACKAGE_ID,
  moduleName: 'CantonStreams.Policy.ExecutionLog',
  entityName: 'ExecutionLog',
};

// ---------------------------------------------------------------------------
// Choice name constants — avoid magic strings in command files
// ---------------------------------------------------------------------------

/** Choices on CreateStreamRequest (numeric). */
export const CHOICE_ACCEPT_STREAM = 'AcceptStream';
export const CHOICE_DECLINE_STREAM = 'DeclineStream';
export const CHOICE_WITHDRAW_REQUEST = 'WithdrawRequest';

/** Choices on StreamEscrow (numeric). */
export const CHOICE_WITHDRAW_STREAM = 'Withdraw_Stream';
export const CHOICE_CANCEL_STREAM = 'Cancel_Stream';
export const CHOICE_MUTUAL_CANCEL_STREAM = 'MutualCancel_Stream';
export const CHOICE_RENEW_STREAM = 'Renew_Stream';
export const CHOICE_COMPLETE_STREAM = 'Complete_Stream';

/** Choices on CreateUtilityHoldingStreamRequest. */
export const CHOICE_ACCEPT_UTILITY_REQUEST = 'AcceptUtilityHoldingRequest';

/** Choices on CreateTokenStandardStreamRequest. */
export const CHOICE_ACCEPT_TOKEN_STANDARD_REQUEST = 'AcceptTokenStandardRequest';

/** Choices on AcceptedUtilityHoldingRequest. */
export const CHOICE_FINALIZE_UTILITY_ESCROW = 'FinalizeUtilityHoldingEscrow';

/** Choices on AcceptedTokenStandardStreamRequest. */
export const CHOICE_FINALIZE_TOKEN_STANDARD_ESCROW = 'FinalizeTokenStandardEscrow';

/** Choices on UtilityHoldingEscrow. */
export const CHOICE_WITHDRAW_UTILITY = 'Withdraw_UtilityHolding';
export const CHOICE_CANCEL_UTILITY = 'Cancel_UtilityHolding';
export const CHOICE_MUTUAL_CANCEL_UTILITY = 'MutualCancel_UtilityHolding';
export const CHOICE_RENEW_UTILITY = 'Renew_UtilityHolding';

/** Choices on TokenStandardEscrow. */
export const CHOICE_WITHDRAW_TOKEN_STANDARD = 'Withdraw_TokenStandard';
export const CHOICE_CANCEL_TOKEN_STANDARD = 'Cancel_TokenStandard';
export const CHOICE_MUTUAL_CANCEL_TOKEN_STANDARD = 'MutualCancel_TokenStandard';
export const CHOICE_RENEW_TOKEN_STANDARD = 'Renew_TokenStandard';

/** Choices on CreateLocalAssetStreamRequest. */
export const CHOICE_ACCEPT_LOCAL_ASSET_REQUEST = 'AcceptLocalAssetRequest';

/** Choices on AcceptedLocalAssetRequest. */
export const CHOICE_FINALIZE_LOCAL_ASSET_ESCROW = 'FinalizeLocalAssetEscrow';

/** Choices on LocalAssetEscrow. */
export const CHOICE_WITHDRAW_LOCAL_ASSET = 'Withdraw_LocalAsset';
export const CHOICE_CANCEL_LOCAL_ASSET = 'Cancel_LocalAsset';
export const CHOICE_MUTUAL_CANCEL_LOCAL_ASSET = 'MutualCancel_LocalAsset';
export const CHOICE_RENEW_LOCAL_ASSET = 'Renew_LocalAsset';

/** Choices on DelegatedPolicy. */
export const CHOICE_EXECUTE_POLICY = 'ExecutePolicy';
export const CHOICE_REVOKE_POLICY = 'RevokePolicy';

// ---------------------------------------------------------------------------
// Template groups — for multi-template queries
// ---------------------------------------------------------------------------

/**
 * All escrow template IDs, for use in unified listStreams() queries.
 * Each entry includes the template ID and its settlement mode for tagging.
 */
export const ESCROW_TEMPLATES = [
  { templateId: TEMPLATE_STREAM_ADMIN, settlementMode: SettlementMode.TokenStandardCustody },
  { templateId: TEMPLATE_STREAM_ESCROW, settlementMode: SettlementMode.NumericLegacy },
  { templateId: TEMPLATE_UTILITY_ESCROW, settlementMode: SettlementMode.UtilityHoldingCustody },
  {
    templateId: TEMPLATE_TOKEN_STANDARD_ESCROW,
    settlementMode: SettlementMode.TokenStandardCustody,
  },
  { templateId: TEMPLATE_LOCAL_ASSET_ESCROW, settlementMode: SettlementMode.LocalAssetCustody },
] as const;

/**
 * All create-request template IDs, for unified pending request queries.
 */
export const CREATE_REQUEST_TEMPLATES = [
  { templateId: TEMPLATE_CREATE_REQUEST, settlementMode: SettlementMode.NumericLegacy },
  {
    templateId: TEMPLATE_UTILITY_CREATE_REQUEST,
    settlementMode: SettlementMode.UtilityHoldingCustody,
  },
  {
    templateId: TEMPLATE_TOKEN_STANDARD_CREATE_REQUEST,
    settlementMode: SettlementMode.TokenStandardCustody,
  },
  {
    templateId: TEMPLATE_LOCAL_ASSET_CREATE_REQUEST,
    settlementMode: SettlementMode.LocalAssetCustody,
  },
] as const;

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

/**
 * Validate that all required template IDs have usable package references.
 *
 * Call this at client startup to fail fast if environment variables are
 * misconfigured or DARs are not deployed. Throws an Error listing all
 * templates with missing package references.
 *
 * @param options.requireUtility — if true, validate utility custody templates
 * @param options.requireLocalAsset — if true, validate local asset templates
 * @param options.requirePolicy — if true, validate Phase 3 policy templates
 */
export function validateTemplateRegistry(options?: {
  requireUtility?: boolean;
  requireLocalAsset?: boolean;
  requirePolicy?: boolean;
}): void {
  const missing: string[] = [];

  const isPackageHash = (value: string): boolean => /^[a-f0-9]{64}$/i.test(value);
  const isPackageName = (value: string): boolean => /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value);

  const check = (label: string, tmpl: TemplateId) => {
    const packageRef = tmpl.packageId.trim();
    if (!packageRef || (!isPackageHash(packageRef) && !isPackageName(packageRef))) {
      missing.push(
        `${label}: packageId="${tmpl.packageId}" (${tmpl.moduleName}:${tmpl.entityName})`,
      );
    }
  };

  // Phase 1 — always required
  check('TEMPLATE_CREATE_REQUEST', TEMPLATE_CREATE_REQUEST);
  check('TEMPLATE_STREAM_ESCROW', TEMPLATE_STREAM_ESCROW);

  // Phase 2 — Utility Custody
  if (options?.requireUtility) {
    check('TEMPLATE_UTILITY_CREATE_REQUEST', TEMPLATE_UTILITY_CREATE_REQUEST);
    check('TEMPLATE_UTILITY_ACCEPTED_REQUEST', TEMPLATE_UTILITY_ACCEPTED_REQUEST);
    check('TEMPLATE_UTILITY_ESCROW', TEMPLATE_UTILITY_ESCROW);
  }

  // Phase 2 — Local Asset Custody
  if (options?.requireLocalAsset) {
    check('TEMPLATE_LOCAL_ASSET_CREATE_REQUEST', TEMPLATE_LOCAL_ASSET_CREATE_REQUEST);
    check('TEMPLATE_LOCAL_ASSET_ACCEPTED_REQUEST', TEMPLATE_LOCAL_ASSET_ACCEPTED_REQUEST);
    check('TEMPLATE_LOCAL_ASSET_ESCROW', TEMPLATE_LOCAL_ASSET_ESCROW);
  }

  // Phase 3 — Delegated Execution
  if (options?.requirePolicy) {
    check('TEMPLATE_DELEGATED_POLICY', TEMPLATE_DELEGATED_POLICY);
    check('TEMPLATE_EXECUTION_LOG', TEMPLATE_EXECUTION_LOG);
  }

  if (missing.length > 0) {
    throw new Error(
      `Template registry validation failed — missing or invalid package references:\n` +
        missing.map((m) => `  • ${m}`).join('\n') +
        `\n\nSet the correct CANTON_STREAMS_*_PACKAGE_ID environment variables ` +
        `to a Daml package name or vetted package hash, or deploy the required DARs.`,
    );
  }
}
