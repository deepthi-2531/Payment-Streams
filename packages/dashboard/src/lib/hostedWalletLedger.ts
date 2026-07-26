/**
 * @module lib/hostedWalletLedger
 *
 * Browser-side Canton Ledger-API client that routes through the
 * connected hosted wallet's CIP-0103 `ledgerApi` surface.
 *
 * Why this exists: a hosted wallet (5N Loop, Cantor8, Send) does
 * not hand the dashboard a JWT for direct participant access.
 * Instead it exposes a vetted subset of the Canton v2 HTTP API
 * via CIP-0103 `ledgerApi({ requestMethod, resource, body })`
 * round-trips that the wallet signs and forwards. This module is
 * the adapter that lets the dashboard talk to that surface
 * without rewriting every call site.
 *
 * What this module DOES today:
 *   - `queryActiveContracts(templateIds, party)` — POSTs the
 *     Loop-compatible filter shape to `/v2/state/acs` and returns
 *     decoded entries.
 *   - `submitAndWait(commands, party)` — POSTs to
 *     `/v2/commands/submit-and-wait` for synchronous command
 *     execution (the wallet drives the user's signing UI).
 *   - `decodeStreamEscrow` / `decodeCreateStreamRequest` — turn
 *     raw create_arguments into the dashboard's `Stream` /
 *     `PendingStreamRequest` shape (Decimal-aware).
 *
 * What this module does NOT do today:
 *   - Per-template decoders for everything (`StreamAdmin`,
 *     V2 `AllocationRequest`, policies). Stubs for those return
 *     `null` and are skipped during list construction — they'll
 *     get real decoders as their flows light up.
 *
 * Filter shape: Loop's adapter at
 * `@partylayer/adapter-loop@0.3.7/dist/index.mjs` reads
 *
 *     parsed.filter.filtersByParty[party].inclusive.templateFilters[0].templateId
 *
 * This is the v1 Daml JSON-API filter shape, NOT the canonical
 * Canton v2 Ledger-API shape (which uses `.cumulative[]` with
 * `identifierFilter.TemplateFilter.value`). We send the v1 shape
 * because Loop only parses that. Non-Loop wallets that also accept
 * `POST /v2/state/acs` will see this shape as a structurally-valid
 * subset; on participants that reject it we fall back to the v2
 * shape inline (caller catches and retries — not implemented in
 * this turn).
 *
 * Template-id format: Loop expects `#<package-name>:<module>:<entity>`
 * (the `#` prefix selects the package by name rather than by hash).
 * `formatHostedTemplateId` converts the SDK's `TemplateId` record.
 *
 * When the streams DAR is not deployed on the network the wallet is
 * attached to, the call throws `TransportError: Loop
 * getActiveContracts() failed for templateId="..." Original error:
 * Failed to get active contracts`. Callers should treat that error
 * as "DAR not vetted on this participant" rather than a hard
 * failure — the dashboard still renders, just with empty
 * collections.
 */

import Decimal from 'decimal.js';
import type {
  Stream,
  PendingStreamRequest,
} from '@canton-streams/sdk/browser';
import {
  VestingMode,
  StreamStatus,
  AssetType,
  SettlementMode,
} from '@canton-streams/sdk/browser';
import { walletClient } from '../store/wallet/index.js';

/**
 * Canton Streams main-package template references, in the
 * Loop-compatible `#<package-name>:<module>:<entity>` form. The
 * dashboard hard-codes these because they are deployment-stable
 * (the streams DAR's daml.yaml `name: canton-streams`), and so
 * that this module does not pull SDK template helpers (which read
 * env vars at module load and are not browser-safe in Vite's dev
 * server).
 *
 * If the DAR is republished under a different package name, update
 * `STREAMS_PACKAGE` once here.
 */
const STREAMS_PACKAGE = 'canton-streams';

export const HOSTED_TID_STREAM_ESCROW =
  `#${STREAMS_PACKAGE}:CantonStreams.Stream.Escrow:StreamEscrow`;
export const HOSTED_TID_CREATE_REQUEST =
  `#${STREAMS_PACKAGE}:CantonStreams.Workflow.CreateStream:CreateStreamRequest`;
export const HOSTED_TID_POLICY =
  `#${STREAMS_PACKAGE}:CantonStreams.Policy.DelegatedPolicy:DelegatedPolicy`;

interface LedgerApiResponseWrapper {
  readonly response?: string;
}

interface AcsActiveContractsResponse {
  readonly activeContracts?: ReadonlyArray<AcsActiveContractEntry>;
  readonly active_contracts?: ReadonlyArray<AcsActiveContractEntry>;
}

interface AcsActiveContractEntry {
  /** v2 shape: `{ created_event: {...} }` or wrappers. */
  readonly created_event?: AcsCreatedEvent;
  readonly createdEvent?: AcsCreatedEvent;
}

interface AcsCreatedEvent {
  readonly contract_id?: string;
  readonly contractId?: string;
  readonly template_id?: string;
  readonly templateId?: string;
  readonly create_arguments?: Record<string, unknown>;
  readonly createArguments?: Record<string, unknown>;
}

/**
 * True if a `ledgerApi` call against the connected wallet is safe.
 */
export function isHostedLedgerAvailable(): boolean {
  return Boolean(
    walletClient.capabilities.hostedMultiWallet &&
      walletClient.capabilities.ledgerApi &&
      typeof walletClient.ledgerApi === 'function',
  );
}

/**
 * Encode a templateId or interfaceId into Loop's expected
 * "#package:module:entity" string form. Accepts an SDK-style
 * `TemplateId` record or the already-encoded string.
 */
export function formatHostedTemplateId(
  ref:
    | string
    | { readonly packageId: string; readonly moduleName: string; readonly entityName: string },
): string {
  if (typeof ref === 'string') {
    return ref.startsWith('#') ? ref : `#${ref}`;
  }
  const pkg = ref.packageId.startsWith('#') ? ref.packageId.slice(1) : ref.packageId;
  return `#${pkg}:${ref.moduleName}:${ref.entityName}`;
}

/**
 * True when a wallet error is the host API explicitly throttling us. Only some
 * adapters keep the status: Loop's ACS read rethrows a bare "Failed to get
 * active contracts" and DISCARDS the 429, so a false here is not proof the
 * wallet is healthy. Used to decide whether retrying is worthwhile, never to
 * claim what went wrong.
 */
export function isWalletRateLimited(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /too many requests|rate[ -]?limit(?:ed|ing)?|\b(?:http|status)[^0-9]{0,10}429\b/i.test(raw);
}

/**
 * A holdings/ACS read that did not complete. Distinct from "the wallet holds
 * nothing" so the UI can keep the last known balance rather than show a dash
 * that reads as zero. Keeps the adapter's original error as `cause`.
 */
export class WalletReadFailedError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Couldn't read holdings from your wallet: ${detail}. The wallet API may be ` +
        'throttling requests (HTTP 429) or briefly unavailable — wait a few seconds and retry.',
    );
    this.name = 'WalletReadFailedError';
    this.cause = cause;
  }
}

/**
 * The read succeeded and the wallet holds nothing spendable of this asset. The
 * counterpart to WalletReadFailedError: only this one means "zero".
 */
export class HoldingsEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldingsEmptyError';
  }
}

/**
 * Read the connected wallet's current ledger-end offset — the snapshot point a
 * v2 ACS query must be pinned to. Returns 0 if the wallet can't answer (older
 * adapters); the caller degrades a failed read to an empty list.
 */
async function walletLedgerEndOffset(
  wc: NonNullable<typeof walletClient.ledgerApi>,
): Promise<number> {
  // Deliberately NOT cached: an ACS snapshot pinned to a stale offset can miss a
  // just-created contract (or return a just-archived one), which would break the
  // read-after-write the settle and post-mutation refreshes depend on.
  try {
    const raw = await wc({ requestMethod: 'get', resource: '/v2/state/ledger-end' });
    const parsed: { offset?: number | string } =
      raw && typeof (raw as LedgerApiResponseWrapper).response === 'string'
        ? (() => {
            try {
              return JSON.parse((raw as LedgerApiResponseWrapper).response!);
            } catch {
              return {};
            }
          })()
        : ((raw as { offset?: number | string }) ?? {});
    const off = Number(parsed.offset);
    return Number.isFinite(off) && off >= 0 ? off : 0;
  } catch {
    return 0;
  }
}

/**
 * Run an ACS query via the active hosted wallet. Returns the
 * decoded `activeContracts` list, or [] if the wallet responded
 * with an empty payload. Throws on transport / wallet rejection
 * so callers can surface an actionable error.
 *
 * The body is the v1 Daml JSON-API filter shape, which is what
 * Loop's CIP-0103 wrapper actually inspects. The participant's
 * v2 Ledger API accepts this subset too (it's a strict subset of
 * the canonical `cumulative + identifierFilter` shape).
 */
export async function queryActiveContractsRaw(
  templateIds: readonly string[],
  party: string,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  if (!isHostedLedgerAvailable()) {
    throw new Error('Hosted wallet ledgerApi is not available on this session');
  }
  if (templateIds.length === 0) return [];
  const wc = walletClient.ledgerApi!;
  // A v2 ACS snapshot must be pinned to a real ledger offset. The old hardcoded
  // '0' is rejected by the participant as an invalid offset, which the Loop
  // adapter reports as the generic "Failed to get active contracts". Use the
  // wallet's current ledger end.
  const activeAtOffset = await walletLedgerEndOffset(wc);
  const body = {
    filter: {
      filtersByParty: {
        [party]: {
          inclusive: {
            templateFilters: templateIds.map((t) => ({ templateId: t })),
          },
        },
      },
    },
    verbose: false,
    activeAtOffset,
  };
  const raw = await wc({
    requestMethod: 'post',
    resource: '/v2/state/acs',
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    // The read didn't complete. Adapters flatten the cause (Loop drops the 429
    // status entirely), so classify by outcome, not by message.
    throw new WalletReadFailedError(err);
  });
  // Loop wraps the response as `{ response: "<stringified json>" }`.
  // Other adapters may return the parsed object directly. Handle both.
  const parsed: AcsActiveContractsResponse = (() => {
    if (raw && typeof (raw as LedgerApiResponseWrapper).response === 'string') {
      try {
        return JSON.parse((raw as LedgerApiResponseWrapper).response!);
      } catch {
        return {};
      }
    }
    return (raw as AcsActiveContractsResponse) ?? {};
  })();
  return (parsed.activeContracts ??
    parsed.active_contracts ??
    []) as ReadonlyArray<Record<string, unknown>>;
}

/**
 * Like queryActiveContractsRaw, but filters by token-standard INTERFACE id(s)
 * with the interface view included. Used to read a non-CC asset's holdings from
 * the wallet when its concrete template id is unknown — every token holding
 * implements the standardized Holding interface, which exposes a uniform
 * { owner, instrumentId, amount } view.
 */
export async function queryActiveContractsByInterfaceRaw(
  interfaceIds: readonly string[],
  party: string,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  if (!isHostedLedgerAvailable()) {
    throw new Error('Hosted wallet ledgerApi is not available on this session');
  }
  if (interfaceIds.length === 0) return [];
  const wc = walletClient.ledgerApi!;
  const activeAtOffset = await walletLedgerEndOffset(wc);
  const body = {
    filter: {
      filtersByParty: {
        [party]: {
          inclusive: {
            interfaceFilters: interfaceIds.map((i) => ({
              interfaceId: i,
              includeInterfaceView: true,
            })),
          },
        },
      },
    },
    verbose: false,
    activeAtOffset,
  };
  const raw = await wc({
    requestMethod: 'post',
    resource: '/v2/state/acs',
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    // The read didn't complete. Adapters flatten the cause (Loop drops the 429
    // status entirely), so classify by outcome, not by message.
    throw new WalletReadFailedError(err);
  });
  const parsed: AcsActiveContractsResponse = (() => {
    if (raw && typeof (raw as LedgerApiResponseWrapper).response === 'string') {
      try {
        return JSON.parse((raw as LedgerApiResponseWrapper).response!);
      } catch {
        return {};
      }
    }
    return (raw as AcsActiveContractsResponse) ?? {};
  })();
  return (parsed.activeContracts ??
    parsed.active_contracts ??
    []) as ReadonlyArray<Record<string, unknown>>;
}

export async function queryActiveContracts(
  templateIds: readonly string[],
  party: string,
): Promise<ReadonlyArray<{ contractId: string; templateId: string; createArguments: Record<string, unknown> }>> {
  const items = await queryActiveContractsRaw(templateIds, party);
  return items
    .map((raw) => {
      // The JSON Ledger API wraps the created event as
      // `{ workflowId, contractEntry: { JsActiveContract: { createdEvent } } }`;
      // other adapters return a flat `created_event`/`createdEvent`. Handle both.
      const entry = raw as AcsActiveContractEntry & {
        readonly contractEntry?: {
          readonly JsActiveContract?: AcsActiveContractEntry;
        } & AcsActiveContractEntry;
      };
      const inner = entry.contractEntry?.JsActiveContract ?? entry.contractEntry;
      const ev =
        entry.created_event ??
        entry.createdEvent ??
        inner?.created_event ??
        inner?.createdEvent;
      if (!ev) return null;
      const cid = ev.contract_id ?? ev.contractId;
      const tid = ev.template_id ?? ev.templateId;
      // Amulet uses `createArgument` (singular) on the JSON Ledger API.
      const args =
        ev.create_arguments ??
        ev.createArguments ??
        (ev as { createArgument?: Record<string, unknown> }).createArgument;
      if (!cid || !tid || !args) return null;
      return { contractId: cid, templateId: tid, createArguments: args };
    })
    .filter((x): x is { contractId: string; templateId: string; createArguments: Record<string, unknown> } => x !== null);
}

/**
 * Probe whether the connected party's participant vets our canton-streams DAR.
 * The custody + flow lanes put a canton-streams contract on-ledger signed by
 * the payer, so they only work where that participant runs our DAR.
 *
 * A READ of a canton-streams template is the reliable signal: it rejects with
 * PACKAGE_NAMES_NOT_FOUND when the DAR is not vetted, whereas the matching WRITE
 * path hangs without settling. Returns false on any non-success (including a
 * timeout), so an uncertain result degrades to direct delivery only — which
 * works on every participant.
 */
export async function probeStreamsDarVetted(party: string): Promise<boolean> {
  if (!isHostedLedgerAvailable()) return false;
  try {
    await Promise.race([
      queryActiveContracts([HOSTED_TID_CREATE_REQUEST], party),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('streams-dar probe timed out')), 8000),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Submit a Daml command (CreateCommand or ExerciseCommand) via the
 * wallet's `POST /v2/commands/submit-and-wait` endpoint. The wallet
 * drives the user's signing surface. Returns the parsed transaction
 * result (shape depends on the wallet's wrapper; callers should
 * treat it as opaque for now and surface `transactionId` /
 * `commandId` when present).
 *
 * Loop's wrapper at
 *   adapter-loop/dist/index.mjs handleSubmitCommand()
 * routes this to `provider.submitAndWaitForTransaction(payload)`.
 * `payload.commands[].templateId` MUST be fully qualified in the
 * `#package-name:module:entity` form; the short
 * `module:entity` form is rejected with the "Execute Unknown on
 * Unknown" UI message.
 */
export async function submitAndWait(
  commands: ReadonlyArray<Record<string, unknown>>,
  party: string,
  options?: {
    readonly commandId?: string;
    readonly applicationId?: string;
    /** Disclosed contracts for choices that reference contracts the payer's
     * participant doesn't host (e.g. a token-standard transfer factory + its
     * registry context). Required for the V1 `TransferFactory_Transfer`. */
    readonly disclosedContracts?: ReadonlyArray<Record<string, unknown>>;
  },
): Promise<unknown> {
  if (!isHostedLedgerAvailable()) {
    throw new Error('Hosted wallet ledgerApi is not available on this session');
  }
  const wc = walletClient.ledgerApi!;
  // Default must be unique per submission — a reused commandId is
  // rejected by the participant as a duplicate command.
  const commandId =
    options?.commandId ?? `dashboard-${party.slice(0, 8)}-${Date.now()}`;
  const body = {
    commands,
    commandId,
    actAs: [party],
    readAs: [party],
    applicationId: options?.applicationId ?? 'canton-streams-dashboard',
    ...(options?.disclosedContracts && options.disclosedContracts.length > 0
      ? { disclosedContracts: options.disclosedContracts }
      : {}),
  };
  const raw = await wc({
    requestMethod: 'post',
    resource: '/v2/commands/submit-and-wait',
    body: JSON.stringify(body),
  });
  if (raw && typeof (raw as LedgerApiResponseWrapper).response === 'string') {
    try {
      return JSON.parse((raw as LedgerApiResponseWrapper).response!);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Fetch a committed update by id from the connected wallet's own participant
 * (POST /v2/updates/update-by-id). Backs wallet-side proof-of-transfer on a
 * non-CC direct settle — the payer's participant can witness the update it just
 * submitted, even though the proxy can't. Returns the parsed update, or null when
 * the wallet can't answer / didn't witness it.
 */
export async function fetchUpdateById(updateId: string): Promise<unknown> {
  if (!isHostedLedgerAvailable() || !updateId) return null;
  const wc = walletClient.ledgerApi!;
  const body = {
    updateId,
    updateFormat: {
      includeTransactions: {
        eventFormat: {
          filtersByParty: {},
          filtersForAnyParty: {
            cumulative: [
              { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
            ],
          },
          verbose: false,
        },
        transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
      },
    },
  };
  try {
    const raw = await wc({
      requestMethod: 'post',
      resource: '/v2/updates/update-by-id',
      body: JSON.stringify(body),
    });
    if (raw && typeof (raw as LedgerApiResponseWrapper).response === 'string') {
      try {
        return JSON.parse((raw as LedgerApiResponseWrapper).response!);
      } catch {
        return null;
      }
    }
    return raw ?? null;
  } catch {
    return null;
  }
}

/**
 * Decode a `StreamEscrow` create_arguments record into the
 * dashboard's `Stream` shape. The Daml record on disk has
 * (roughly) the same field names as `RawStream` from the REST
 * proxy; we re-use the proxy's deserializer shape so call-sites
 * don't have to fork.
 *
 * Returns null if the record doesn't look like a StreamEscrow —
 * callers should filter nulls before rendering.
 */
export function decodeStreamEscrow(
  contractId: string,
  args: Record<string, unknown>,
): Stream | null {
  const cfg = (args.config ?? {}) as Record<string, unknown>;
  const state = (args.state ?? {}) as Record<string, unknown>;
  const escrow = (args.escrowRef ?? args.escrow_ref ?? null) as Record<
    string,
    unknown
  > | null;

  const streamId = readString(cfg, 'streamId', 'stream_id');
  const sender = readString(cfg, 'sender');
  const recipient = readString(cfg, 'recipient');
  if (!streamId || !sender || !recipient) return null;

  const total = readDecimal(cfg, 'totalDeposited', 'total_deposited');
  const withdrawn = readDecimal(state, 'totalWithdrawn', 'total_withdrawn');

  const startTime = readDate(cfg, 'startTime', 'start_time');
  const endTime = readDate(cfg, 'endTime', 'end_time');
  if (!startTime || !endTime) return null;

  const vestingModeRaw = readString(cfg, 'vestingMode', 'vesting_mode') ?? 'Linear';
  const vestingMode = normalizeVestingMode(vestingModeRaw);

  const assetTypeRaw = readString(cfg, 'assetType', 'asset_type') ?? 'CC';
  const assetType = normalizeAssetType(assetTypeRaw);

  const settlementModeRaw = readString(cfg, 'settlementMode', 'settlement_mode');
  const settlementMode = settlementModeRaw
    ? normalizeSettlementMode(settlementModeRaw)
    : undefined;

  const statusRaw = readString(state, 'status') ?? 'Pending';
  const status = normalizeStreamStatus(statusRaw);

  const renewalCount = Number(state.renewalCount ?? state.renewal_count ?? 0);
  const cancellable = Boolean(cfg.cancellable ?? false);

  // VestingModeConfig is a discriminated union — pick the right
  // variant. Each variant has additional required fields the
  // decoder fills with defaults read from the Daml record when
  // present; if a required field is missing we fall back to
  // `LinearVestingConfig` (the safest renderable shape).
  const vestingConfig = buildVestingConfig(vestingMode, cfg, startTime, endTime);

  const stream: Stream = {
    contractId,
    config: {
      streamId,
      sender,
      recipient,
      totalDeposited: total ?? new Decimal(0),
      startTime,
      endTime,
      vestingMode: vestingConfig,
      assetType,
      ...(settlementMode ? { settlementMode } : {}),
      cancellable,
    },
    state: {
      totalWithdrawn: withdrawn ?? new Decimal(0),
      status,
      renewalCount,
    },
    // EscrowRef requires instrumentRef which we don't decode in
    // this turn. Skip rather than synthesize fake instrument
    // metadata that would mislead the UI.
  };
  void escrow;
  return stream;
}

function buildVestingConfig(
  mode: VestingMode,
  cfg: Record<string, unknown>,
  startTime: Date,
  endTime: Date,
): Stream['config']['vestingMode'] {
  void startTime;
  void endTime;
  if (mode === VestingMode.CliffLinear) {
    const cliff = readDate(cfg, 'cliffTime', 'cliff_time');
    if (cliff) return { mode: VestingMode.CliffLinear, cliffTime: cliff };
  }
  if (mode === VestingMode.Stepped) {
    const stepInterval = Number(cfg.stepInterval ?? cfg.step_interval ?? 0);
    const amountPerStep = readDecimal(cfg, 'amountPerStep', 'amount_per_step');
    if (stepInterval > 0 && amountPerStep) {
      return {
        mode: VestingMode.Stepped,
        stepInterval,
        amountPerStep,
      };
    }
  }
  if (mode === VestingMode.RenewableTerm) {
    const termDuration = Number(cfg.termDuration ?? cfg.term_duration ?? 0);
    if (termDuration > 0) {
      return { mode: VestingMode.RenewableTerm, termDuration };
    }
  }
  return { mode: VestingMode.Linear };
}

/**
 * Decode a `CreateStreamRequest` create_arguments record into a
 * `PendingStreamRequest`. Same convention as `decodeStreamEscrow` —
 * return null if the record doesn't look like a request and let the
 * caller filter it out.
 */
export function decodeCreateStreamRequest(
  contractId: string,
  templateId: string,
  args: Record<string, unknown>,
): PendingStreamRequest | null {
  void templateId;
  const cfg = (args.config ?? args.proposedConfig ?? {}) as Record<string, unknown>;
  const sender = readString(cfg, 'sender');
  const recipient = readString(cfg, 'recipient');
  const streamId = readString(cfg, 'streamId', 'stream_id');
  if (!sender || !recipient || !streamId) return null;
  const assetTypeRaw = readString(cfg, 'assetType', 'asset_type') ?? 'CC';
  const total = readDecimal(cfg, 'totalDeposited', 'total_deposited');
  const startTime = readDate(cfg, 'startTime', 'start_time');
  const endTime = readDate(cfg, 'endTime', 'end_time');
  if (!startTime || !endTime) return null;
  const vestingModeRaw =
    readString(cfg, 'vestingMode', 'vesting_mode') ?? 'Linear';
  const settlementModeRaw =
    readString(cfg, 'settlementMode', 'settlement_mode') ?? 'TokenStandardCustody';
  const observersRaw = (args.observers ?? args.observer_parties ?? []) as unknown[];
  const observers = Array.isArray(observersRaw)
    ? observersRaw.filter((o): o is string => typeof o === 'string')
    : [];
  return {
    contractId,
    config: {
      streamId,
      sender,
      recipient,
      totalDeposited: total ?? new Decimal(0),
      startTime,
      endTime,
      vestingMode: buildVestingConfig(
        normalizeVestingMode(vestingModeRaw),
        cfg,
        startTime,
        endTime,
      ),
      assetType: normalizeAssetType(assetTypeRaw),
      cancellable: Boolean(cfg.cancellable ?? false),
      settlementMode: normalizeSettlementMode(settlementModeRaw),
    },
    observers,
    settlementMode: normalizeSettlementMode(settlementModeRaw),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readString(
  src: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function readDecimal(
  src: Record<string, unknown>,
  ...keys: readonly string[]
): Decimal | undefined {
  for (const k of keys) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    try {
      return new Decimal(typeof v === 'string' ? v : String(v));
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

function readDate(
  src: Record<string, unknown>,
  ...keys: readonly string[]
): Date | undefined {
  for (const k of keys) {
    const v = src[k];
    if (typeof v !== 'string') continue;
    // Canton often surfaces microsecond-resolution unix timestamps
    // as 16-19 digit strings; otherwise the field is ISO-8601.
    if (/^\d{15,19}$/.test(v)) {
      const us = BigInt(v);
      const ms = Number(us / 1000n);
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function normalizeVestingMode(raw: string): VestingMode {
  const k = raw.toLowerCase();
  if (k.includes('cliff')) return VestingMode.CliffLinear;
  if (k.includes('step')) return VestingMode.Stepped;
  if (k.includes('renew')) return VestingMode.RenewableTerm;
  return VestingMode.Linear;
}

function normalizeAssetType(raw: string): AssetType {
  const k = raw.toLowerCase();
  if (k.includes('validator') || k.includes('local-asset')) {
    return AssetType.ValidatorLocalAsset;
  }
  if (k.includes('localcip') || k.includes('local-cip') || k.includes('private')) {
    return AssetType.LocalCip56;
  }
  return AssetType.GlobalCip56;
}

function normalizeSettlementMode(raw: string): SettlementMode {
  if (raw.includes('TokenStandard')) return SettlementMode.TokenStandardCustody;
  if (raw.includes('LocalAsset')) return SettlementMode.LocalAssetCustody;
  if (raw.includes('UtilityHolding')) return SettlementMode.UtilityHoldingCustody;
  return SettlementMode.NumericLegacy;
}

function normalizeStreamStatus(raw: string): StreamStatus {
  const k = raw.toLowerCase();
  if (k.includes('completed') || k.includes('complete')) return StreamStatus.Completed;
  if (k.includes('cancel')) return StreamStatus.Cancelled;
  // Default to Active — there is no `Pending` lifecycle state on
  // the Daml StreamEscrow template; a contract that exists is by
  // definition active until completed/cancelled.
  return StreamStatus.Active;
}
