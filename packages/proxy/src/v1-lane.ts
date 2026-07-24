/**
 * V1 transfer-instruction lane — proxy port of the PROVEN settlement code
 * from `scripts/interest-stream-scheduler.mjs` (Payment-Streams).
 *
 * This module is a faithful, dependency-free port of the scheduler's
 * money-moving path so the proxy can stand up and settle a "V1 stream"
 * in-process, without shelling out to the standalone daemon (which does
 * not ship in this repo's `scripts/`).
 *
 * What a "V1 stream" supports:
 *
 * Proven direct-delivery lane:
 *   - There is NO on-chain funding lock and NO escrow custody contract.
 *   - The PAYER holds unlocked Amulet/CC directly in its own wallet; each
 *     cycle is paid out live via a single-signed `TransferFactory_Transfer`
 *     (the recipient pre-registered a `TransferPreapproval`, kind=direct,
 *     so no per-cycle recipient signature is needed).
 *   - An OPTIONAL on-ledger `StreamAdmin` contract is the per-stream
 *     observability RECORD (signatory=sender, observers=recipient+operator).
 *     It is created up front and advanced per settled cycle via
 *     `Sync_Iteration`. If absent, money still moves; only the record is
 *     skipped.
 *
 * Receiver-claim lane:
 *   - The sender funds one V1 Allocation and creates `ReceiverClaimV1`
 *     (signatory=sender, observers=recipient+executor) once.
 *   - The recipient claims after `unlockAt` by exercising
 *     `ReceiverClaimV1.Claim`; the proxy supplies the registry's live
 *     execute-transfer choice-context/disclosed contracts.
 *   - Controlled-validator default is executor == recipient, so the claim is a
 *     single-party wallet action for the receiver once the shim DAR is vetted.
 *
 * The HTTP helpers (`ledger`, `registryPost`, `submit`), `senderHoldings`,
 * `settleCycle`, `resolveStreamAdminCid` and `syncStreamAdmin` are ported
 * verbatim from the scheduler (interest-stream-scheduler.mjs:108-152,
 * 247-328). The accrual/arrears math (`accruedAmount`/`dueAmount`,
 * :224-241) is ported so the proxy's on-demand settle computes the same
 * "due this cycle" amount the daemon would.
 *
 * Wire-format notes (proven on Canton 3.5 JSON Ledger API v2):
 *   - The JSON Ledger API v2 uses PLAIN-JSON record encoding for
 *     create/exercise arguments and ACS `createArgument` (the scheduler
 *     reads `createArgument.streamId` as a bare string,
 *     `createArgument.numIterations` as a number, and
 *     `createArgument.amount.initialAmount` as a nested record). The
 *     `StreamAdmin` CreateCommand below therefore uses plain records:
 *     a Daml variant (`vestingMode`) is `{ tag, value }` and a Daml enum
 *     (`status`) is the bare constructor string.
 *   - ACS *filters* require package-NAME template ids (`#name:Module:Entity`);
 *     *commands* accept either the name id or a pinned package-hash id.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { acquireStoreLock, releaseStoreLock } from './store-lock.js';
import { getSupportedAssets } from './assets.js';

// Standardized token-standard TransferInstruction interface package NAMES. The
// ledger ACS InterfaceFilter requires the `#package-name` form; the exercise
// path may instead be configured with a concrete package id, so these are kept
// separate from config.transferInstructionInterfaceId to interface-filter the
// ACS reliably regardless of how the exercise id is configured.
export const TI_INTERFACE_NAME_V1 =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction';
export const TI_INTERFACE_NAME_V2 =
  '#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferInstruction';

// ---------------------------------------------------------------------------
// Configuration (V1 lane env — see the task's envAndIds spec)
// ---------------------------------------------------------------------------

const env = (k: string, d = ''): string => String(process.env[k] ?? d).trim();

export interface V1LaneConfig {
  /** JSON Ledger API v2 base of the participant hosting the payer party. */
  apiUrl: string;
  /** Bearer JWT for the JSON Ledger API (omit only when auth is disabled). */
  ledgerToken: string;
  /** Explicit ledger userId; required when participant auth is OFF. */
  userId: string;
  /** GLOBAL Scan base host for the transfer-factory choice-context endpoint. */
  registryApiUrl: string;
  /** DSO / instrument-admin (Amulet admin) party. */
  ccAdminParty: string;
  /** Instrument id (default 'Amulet' = CC). */
  instrumentId: string;
  /** Concrete holding template the payer funds from. */
  holdingTemplateId: string;
  /** Standardized token Holding interface id — used to read a non-CC custody
   *  balance by interface view when the concrete holding template's field shape
   *  is unknown. CC keeps its concrete Amulet template read. */
  holdingInterfaceId: string;
  /** On-ledger record template id (StreamAdmin) for create + Sync_Iteration. */
  streamAdminTemplateId: string;
  /** Operator-signed direct-transfer index template id (StreamRecord). */
  streamRecordTemplateId: string;
  /** Operator-custodied escrow party — holds deposited funds and streams them
   * out. Empty disables the escrow lane. */
  escrowParty: string;
  /** OperatorEscrow template id (operator-signed custodial escrow record). */
  operatorEscrowTemplateId: string;
  /** Splice validator app API base, e.g. http://127.0.0.1:5003/api/validator —
   * used to set up the escrow party's TransferPreapproval. */
  validatorApiUrl: string;
  /** Validator app JWT audience + HS256 secret for its wallet API. */
  validatorAuthAudience: string;
  validatorAuthSecret: string;
  /** Escrow streamer tick interval in seconds (auto-release cadence check). */
  escrowTickSeconds: number;
  /** TransferFactory interface id on the TransferFactory_Transfer exercise. */
  transferFactoryInterfaceId: string;
  /** v2 TransferFactory interface id (v2 direct-delivery money leg). */
  transferFactoryInterfaceIdV2: string;
  /** Token-standard version for the direct-transfer money leg ('v1' | 'v2'). */
  transferVersion: 'v1' | 'v2';
  /** TransferInstruction interface id for Accept/Withdraw of pending offers. */
  transferInstructionInterfaceId: string;
  /** v2 TransferInstruction interface id (v2 accept/withdraw of pending offers). */
  transferInstructionInterfaceIdV2: string;
  /** Registry AllocationFactory interface id for receiver-claim funding. */
  allocationFactoryInterfaceId: string;
  /** V1 Allocation interface id exercised through ReceiverClaimV1. */
  allocationInterfaceId: string;
  /** Concrete V1 allocation template used only for operator-side ACS discovery. */
  allocationTemplateId: string;
  /** Receiver-claim shim template id. */
  receiverClaimTemplateId: string;
  /** Operator party for StreamAdmin (controls Sync_Iteration). Defaults to payer. */
  operatorParty: string;
  /** transfer.executeBefore window in seconds. */
  executeBeforeSeconds: number;
  /** allocation.allocateBefore window in seconds. */
  allocateBeforeSeconds: number;
  /** allocation.settleBefore/claim expiry window in seconds after unlock. */
  settleBeforeSeconds: number;
  /** Acknowledge that this deployment runs operator-custodial: the operator's
   * participant submits a co-hosted payer's money leg with its own authority.
   * Off by default, so an operator-authority transfer of a party hosted here is
   * refused unless custody is disclosed. In the intended topology the payer is on
   * its own participant and never triggers it. */
  disclosedCustody: boolean;
  /** Aggregate cap in CC on total tracked escrow obligation; 0 disables it. */
  escrowMaxTotalCC: number;
  /** Cadence in seconds for the continuous escrow solvency drift probe. */
  solvencyMonitorSeconds: number;
  /** Path to the proxy-owned V1 state file (settled totals + history). */
  stateFile: string;
}

export function parseV1LaneConfig(e: NodeJS.ProcessEnv = process.env): V1LaneConfig {
  const get = (k: string, d = ''): string => String(e[k] ?? d).trim();
  return {
    apiUrl: get('CANTON_JSON_API_URL', 'http://localhost:7575').replace(/\/+$/, ''),
    ledgerToken: get('CANTON_LEDGER_TOKEN'),
    userId: get('CANTON_USER_ID'),
    registryApiUrl: get('REGISTRY_API_URL').replace(/\/+$/, ''),
    ccAdminParty: get('CC_ADMIN_PARTY'),
    instrumentId: get('INSTRUMENT_ID', 'Amulet'),
    holdingTemplateId: get('HOLDING_TEMPLATE_ID', '#splice-amulet:Splice.Amulet:Amulet'),
    holdingInterfaceId: get(
      'HOLDING_INTERFACE_ID',
      '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding',
    ),
    streamAdminTemplateId: get(
      'STREAM_ADMIN_TEMPLATE_ID',
      '#canton-streams:CantonStreams.Stream.StreamAdmin:StreamAdmin',
    ),
    streamRecordTemplateId: get(
      'STREAM_RECORD_TEMPLATE_ID',
      '#canton-streams:CantonStreams.Stream.StreamRecord:StreamRecord',
    ),
    escrowParty: get('ESCROW_PARTY'),
    operatorEscrowTemplateId: get(
      'OPERATOR_ESCROW_TEMPLATE_ID',
      '#canton-streams:CantonStreams.Stream.OperatorEscrow:OperatorEscrow',
    ),
    validatorApiUrl: get('VALIDATOR_API_URL').replace(/\/+$/, ''),
    validatorAuthAudience: get('VALIDATOR_AUTH_AUDIENCE'),
    validatorAuthSecret: get('VALIDATOR_AUTH_SECRET'),
    escrowTickSeconds: Number(get('ESCROW_STREAM_TICK_SECONDS', '30')),
    transferFactoryInterfaceId: get(
      'TRANSFER_FACTORY_INTERFACE_ID',
      '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory',
    ),
    transferFactoryInterfaceIdV2: get(
      'TRANSFER_FACTORY_INTERFACE_ID_V2',
      '#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferFactory',
    ),
    transferVersion: get('TRANSFER_VERSION', 'v1') === 'v2' ? 'v2' : 'v1',
    transferInstructionInterfaceId: get(
      'TRANSFER_INSTRUCTION_INTERFACE_ID',
      '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction',
    ),
    transferInstructionInterfaceIdV2: get(
      'TRANSFER_INSTRUCTION_INTERFACE_ID_V2',
      '#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferInstruction',
    ),
    allocationFactoryInterfaceId: get(
      'V1_ALLOCATION_FACTORY_INTERFACE_ID',
      '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory',
    ),
    allocationInterfaceId: get(
      'V1_ALLOCATION_INTERFACE_ID',
      '#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation',
    ),
    allocationTemplateId: get(
      'V1_ALLOCATION_TEMPLATE_ID',
      '#splice-amulet:Splice.AmuletAllocation:AmuletAllocation',
    ),
    receiverClaimTemplateId: get(
      'V1_RECEIVER_CLAIM_TEMPLATE_ID',
      '#canton-streams-v1-shim:CantonStreams.V1Shim.ReceiverClaim:ReceiverClaimV1',
    ),
    operatorParty: get('V1_OPERATOR_PARTY') || get('CANTON_USER_ID'),
    executeBeforeSeconds: Number(get('EXECUTE_BEFORE_SECONDS', '3600')),
    allocateBeforeSeconds: Number(get('ALLOCATE_BEFORE_SECONDS', '3600')),
    settleBeforeSeconds: Number(get('SETTLE_BEFORE_SECONDS', '86400')),
    disclosedCustody:
      get('ESCROW_DISCLOSED_CUSTODY') === 'true' || get('COHOST_DISCLOSED_CUSTODY') === 'true',
    escrowMaxTotalCC: nonNegNumber(get('ESCROW_MAX_TOTAL_CC', '0')),
    solvencyMonitorSeconds: nonNegNumber(get('ESCROW_SOLVENCY_MONITOR_SECONDS', '0')),
    stateFile: get('V1_STATE_FILE', './v1-stream-state.json'),
  };
}

/** Coerce an env number, failing safe to 0 (disabled) on a typo or negative,
 * warning once so a misconfigured limit isn't silently off. */
function nonNegNumber(raw: string): number {
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`ignoring invalid numeric config "${raw}"; treating as 0 (disabled)`);
    return 0;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Agreement / stream shapes
// ---------------------------------------------------------------------------

export type Cadence = 'second' | 'minute' | 'hourly' | 'daily';
export type ArrearsPolicy = 'catch-up' | 'skip-missed';

/**
 * A V1 stream agreement — the exact field names the proven scheduler reads
 * (see the task's agreementFormat spec). `agreementId` doubles as the
 * StreamAdmin `streamId`.
 */
export interface V1Agreement {
  agreementId: string;
  appId?: string;
  payerParty: string;
  recipientParty: string;
  ratePerPeriod: string;
  cadence: Cadence;
  effectiveFrom: string;
  termEnd?: string;
  arrearsPolicy?: ArrearsPolicy;
  /** Contract id of the pre-created StreamAdmin record (optional). */
  streamAdminCid?: string;
  /** Contract id of the operator-signed StreamRecord index (optional). */
  streamRecordCid?: string;
  /** Total committed at create time — stamped onto StreamAdmin.totalDeposited. */
  totalDeposited?: string;
  /** ISO timestamp the agreement row was created. */
  createdAt?: string;
  /** Lifecycle: 'stopped' halts accrual + settlement. Undefined ⇒ active. */
  status?: 'active' | 'stopped';
  /** Whitelisted asset-registry key this stream pays (e.g. 'cc', 'usdcx').
   *  Absent ⇒ the proxy's global/default asset (CC). */
  assetKey?: string;
  /** Per-stream settlement instrument, resolved from the asset registry at
   *  create time and frozen here so registry drift cannot retarget a live
   *  stream. Absent fields fall back to the proxy's global CC config — so a
   *  stream created without an instrument settles exactly as before. */
  instrument?: {
    admin: string;
    id: string;
    holdingTemplateId?: string;
    registryApiUrl?: string;
    transferVersion?: 'v1' | 'v2';
    decimals?: number;
  };
}

export interface CycleRecord {
  at: string;
  amount: string;
  ref: string;
  updateId: string;
  /** Set when a non-CC cycle was recorded against a wallet-verified delivered
   *  transfer object (proof-of-transfer), not the interim trust path. */
  verified?: boolean;
}

/**
 * Wallet-side proof-of-transfer for a non-CC direct settle. The payer wallet's
 * own participant witnessed the update it submitted (the proxy can't — both
 * parties are remote and the asset isn't on Canton Coin's Scan), so it supplies
 * the transfer object recorded here. Structurally validated in `recordSettle`
 * against the agreement before any credit; a mismatch fails closed.
 */
export interface TransferProof {
  sender?: string;
  receiver: string;
  amount: string;
  instrumentId: string;
  instrumentAdmin?: string;
  /** true = a completed direct delivery (recipient Holding created); false = a
   *  pending TransferOffer awaiting the recipient's accept. */
  delivered: boolean;
}

export type ReceiverClaimStatus =
  | 'allocated'
  | 'claim_ready'
  | 'claimed'
  | 'withdrawn';

export interface ReceiverClaimRecord {
  cycle: number;
  amount: string;
  ref: string;
  executor: string;
  allocationCid: string;
  receiverClaimCid?: string;
  allocationUpdateId?: string;
  claimUpdateId?: string;
  unlockAt: string;
  expiresAt: string;
  createdAt: string;
  status: ReceiverClaimStatus;
}

/**
 * A pending transfer offer — the result of a cycle's `TransferFactory_Transfer`
 * when the receiver has NO pre-approval, so the registry returns a
 * `TransferInstruction` the receiver must accept (rather than completing the
 * transfer directly). Tracked here so Bob can `Accept` and Alice can `Withdraw`
 * (retry) after expiry. A `pending` offer has NOT moved money — `settled`/
 * `cycles` advance only when it becomes `accepted`.
 */
export type PendingTransferStatus = 'pending' | 'accepted' | 'withdrawn' | 'expired';

export interface PendingTransferRecord {
  cycle: number;
  amount: string;
  ref: string;
  /** The TransferInstruction contract the receiver accepts / sender withdraws. */
  transferInstructionCid: string;
  /** updateId of the TransferFactory_Transfer that created the offer (on Scan). */
  createUpdateId?: string;
  /** updateId of the accepted/withdrawn settlement once finalized (on Scan). */
  finalUpdateId?: string;
  /** transfer.executeBefore — after this the offer expires and Alice may retry. */
  executeBefore: string;
  createdAt: string;
  status: PendingTransferStatus;
}

export interface V1StreamState {
  settled: number;
  cycles: number;
  history: CycleRecord[];
  receiverClaims?: ReceiverClaimRecord[];
  pendingTransfers?: PendingTransferRecord[];
}

interface V1Store {
  agreements: Record<string, V1Agreement>;
  state: Record<string, V1StreamState>;
}

const PERIOD_MS: Record<Cadence, number> = {
  second: 1_000,
  minute: 60_000,
  hourly: 3_600_000,
  daily: 86_400_000,
};

export class V1LaneError extends Error {
  statusCode: number;
  reason: string;
  constructor(statusCode: number, reason: string, message: string) {
    super(message);
    this.name = 'V1LaneError';
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (ported verbatim from interest-stream-scheduler.mjs:108-140)
// ---------------------------------------------------------------------------

export async function ledger(
  config: V1LaneConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.ledgerToken) headers['Authorization'] = `Bearer ${config.ledgerToken}`;
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  if (!res.ok) {
    const d = t.length > 900 ? `${t.slice(0, 300)} … ${t.slice(-500)}` : t;
    throw new V1LaneError(502, 'ledger_error', `${method} ${path} ${res.status}: ${d}`);
  }
  return t ? JSON.parse(t) : {};
}

// Whether a party is hosted on this (the operator's) participant. Cached: a
// local=true result is kept indefinitely (it only makes the guard stricter),
// while local=false is re-checked after a short TTL so a later re-hosting isn't
// missed.
const partyLocalCache = new Map<string, { local: boolean; at: number }>();
async function partyIsLocal(config: V1LaneConfig, party: string): Promise<boolean> {
  const cached = partyLocalCache.get(party);
  // local=true is cached indefinitely (it only tightens the guard); local=false is
  // re-checked after a short window so a party re-hosted here is caught promptly.
  if (cached && (cached.local || Date.now() - cached.at < 30 * 1000)) return cached.local;
  let details: unknown;
  try {
    const r = await ledger(config, 'GET', `/v2/parties/${encodeURIComponent(party)}`);
    details = (r as any).partyDetails ?? (r as any).party_details;
  } catch (err) {
    // Cannot determine hosting — fail closed so a claimed-non-custodial deployment
    // never silently submits with operator authority it couldn't verify.
    throw new V1LaneError(
      502,
      'undisclosed_custody_probe_failed',
      `cannot determine whether ${party} is hosted here; refusing the operator-authority submission (${(err as Error).message})`,
    );
  }
  if (!Array.isArray(details)) {
    // A 200 whose shape we don't recognise is not a not-local signal — fail closed
    // rather than let an unexpected envelope wave through a custodial move.
    throw new V1LaneError(
      502,
      'undisclosed_custody_probe_failed',
      `party hosting response for ${party} was not in the expected shape; refusing the operator-authority submission`,
    );
  }
  const local = details.some((d: any) => d?.isLocal === true || d?.is_local === true);
  // A not-local result must come from a recognized signal — a positive boolean
  // flag somewhere, or a genuinely empty array (the party isn't known here) — not
  // from a populated array that simply omits the flag, which we can't interpret.
  if (!local) {
    const recognized =
      details.length === 0 ||
      details.some((d: any) => typeof (d?.isLocal ?? d?.is_local) === 'boolean');
    if (!recognized) {
      throw new V1LaneError(
        502,
        'undisclosed_custody_probe_failed',
        `party hosting flag for ${party} was absent; refusing the operator-authority submission`,
      );
    }
  }
  partyLocalCache.set(party, { local, at: Date.now() });
  return local;
}

/** Refuse to submit a party's money leg with the operator participant's own
 * authority when that party is hosted here, unless the operator has acknowledged
 * running custodially. This turns "non-custodial by topology" into an enforced
 * property: in the intended topology the payer is on its own participant, the
 * probe returns not-local, and nothing changes; a silent co-hosting misconfig is
 * caught instead of quietly reintroducing operator custody. The operator's own
 * escrow custody party is exempt — its releases and refunds are custodial by
 * design and already disclosed. */
async function assertNotUndisclosedCustody(config: V1LaneConfig, sender: string, ctx: string): Promise<void> {
  if (config.escrowParty && sender === config.escrowParty) return;
  if (config.disclosedCustody) return;
  if (await partyIsLocal(config, sender)) {
    throw new V1LaneError(
      403,
      'undisclosed_custody',
      `refusing to move ${sender}'s funds with the operator participant's authority (${ctx}): that party is hosted here, so this is a custodial move. In the intended topology the payer signs on its own participant. Set ESCROW_DISCLOSED_CUSTODY=true to run operator-custodial knowingly.`,
    );
  }
}

async function registryPost(
  config: V1LaneConfig,
  path: string,
  body: unknown,
  baseUrl?: string,
): Promise<any> {
  const base = (baseUrl || config.registryApiUrl).replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const t = await res.text();
  if (!res.ok) {
    throw new V1LaneError(502, 'registry_error', `registry ${path} ${res.status}: ${t.slice(0, 400)}`);
  }
  return JSON.parse(t);
}

function mapDisclosedContracts(ctx: any): unknown[] {
  return (ctx.disclosedContracts ?? ctx.disclosed_contracts ?? []).map((d: any) => ({
    templateId: d.templateId ?? d.template_id,
    contractId: d.contractId ?? d.contract_id,
    createdEventBlob: d.createdEventBlob ?? d.created_event_blob,
    synchronizerId: d.synchronizerId ?? d.synchronizer_id ?? '',
  }));
}

function choiceContextValues(ctx: any): { values: Record<string, unknown> } {
  const data = ctx.choiceContextData ?? ctx.choice_context_data ?? {};
  if (typeof data.values === 'object' && data.values !== null) {
    return data;
  }
  return { values: data };
}

let submitCounter = 0;
export async function submit(
  config: V1LaneConfig,
  tag: string,
  actAs: string[],
  commands: unknown[],
  disclosedContracts: unknown[] = [],
): Promise<any> {
  return ledger(config, 'POST', '/v2/commands/submit-and-wait', {
    commands,
    commandId: `proxy-v1-${tag}-${Date.now()}-${++submitCounter}`,
    actAs,
    readAs: [],
    ...(config.userId ? { userId: config.userId } : {}),
    ...(disclosedContracts.length ? { disclosedContracts } : {}),
  });
}

function v1Sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface DeliveryLeg {
  /** Present only on a transfer-spec leg (the transfer authorization carries it).
   * A created-holding leg has no sender — the holding only names its owner. */
  sender?: string;
  receiver: string;
  amount: number;
  instrumentOk: boolean;
  agreement?: string;
}

function pickKey(o: any, keys: string[]): any {
  for (const k of keys) if (o != null && o[k] !== undefined) return o[k];
  return undefined;
}

function ccInstrumentMatches(instId: unknown, config: V1LaneConfig): boolean {
  if (instId == null) return false;
  if (typeof instId === 'string') return instId === config.instrumentId;
  // Bind the admin too when the on-chain instrument carries it: an id string
  // ('Amulet', 'USDCx', …) is only unique within an admin, so two assets can
  // share an id across different registrars. id alone is not a safe match.
  const admin = pickKey(instId, ['admin']);
  if (admin != null && String(admin) !== config.ccAdminParty) return false;
  return String(pickKey(instId, ['id', 'instrumentId'])) === config.instrumentId;
}

/**
 * Decode a token-standard transfer spec — the argument of a
 * `TransferFactory_Transfer` exercise, or a `TransferInstruction`'s transfer
 * field — into a leg. `sender`/`receiver` may be a bare party or a `{ owner }`
 * record; the amount, instrument, and `cantonstreams.dev/agreement` metadata are
 * read out. Binding both parties from the transfer authorization itself (rather
 * than by substring, or from a created holding whose owner is only the receiver)
 * is what stops a change/refund leg or a reverse-direction transfer from being
 * mistaken for a payer->recipient delivery.
 */
function transferSpecLeg(t: any, config: V1LaneConfig): DeliveryLeg | null {
  if (!t || typeof t !== 'object') return null;
  const amount = Number(pickKey(t, ['amount']));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const sRaw = pickKey(t, ['sender']);
  const rRaw = pickKey(t, ['receiver']);
  const sender = sRaw && typeof sRaw === 'object' ? pickKey(sRaw, ['owner']) : sRaw;
  const receiver = rRaw && typeof rRaw === 'object' ? pickKey(rRaw, ['owner']) : rRaw;
  if (typeof sender !== 'string' || typeof receiver !== 'string') return null;
  const values = pickKey(pickKey(t, ['meta']) ?? {}, ['values']);
  const agreement = values ? pickKey(values, ['cantonstreams.dev/agreement']) : undefined;
  return {
    sender,
    receiver,
    amount,
    instrumentOk: ccInstrumentMatches(pickKey(t, ['instrument_id', 'instrumentId']), config),
    agreement: typeof agreement === 'string' ? agreement : undefined,
  };
}

/**
 * Decode a created CC holding into a credit leg for its owner. When a
 * pending offer is accepted, the committed update carries no transfer spec — the
 * money shows up as a freshly-created holding owned by the receiver. Recognising
 * it lets an accept be verified structurally (by who the holding lands on),
 * instead of by a text match. There is no sender on a holding leg — the sender is
 * bound separately, by the offer's own contract id.
 */
function holdingCreditLeg(node: any, config: V1LaneConfig): DeliveryLeg | null {
  const tid = pickKey(node, ['template_id', 'templateId']);
  if (typeof tid !== 'string') return null;
  // Match the configured CC holding by module + entity (the last two segments),
  // not just the trailing name, so a same-named token in a different module can't
  // be counted as CC. The package qualifier differs (a hash on chain vs a #name
  // in config), so it is not compared.
  const templateKey = (id: string): string => id.split(':').slice(-2).join(':');
  if (templateKey(tid) !== templateKey(config.holdingTemplateId)) return null;
  const args = pickKey(node, ['create_arguments', 'createArguments', 'create_argument']);
  if (!args || typeof args !== 'object') return null;
  const owner = pickKey(args, ['owner']);
  if (typeof owner !== 'string') return null;
  const amtField = pickKey(args, ['amount']);
  const amount = Number(
    amtField && typeof amtField === 'object' ? pickKey(amtField, ['initialAmount', 'initial_amount']) : amtField,
  );
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { receiver: owner, amount, instrumentOk: true };
}

/** Walk a committed Scan update tree and collect every value-delivery leg: a
 * decodable transfer spec (carries both parties) and a created CC holding
 * (carries only its owner), wherever each appears. */
function collectDeliveryLegs(updateBody: string, config: V1LaneConfig): DeliveryLeg[] {
  let root: unknown;
  try {
    root = JSON.parse(updateBody);
  } catch {
    return [];
  }
  const legs: DeliveryLeg[] = [];
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    const spec = transferSpecLeg(pickKey(node as Record<string, any>, ['transfer']), config);
    if (spec) legs.push(spec);
    const holding = holdingCreditLeg(node, config);
    if (holding) legs.push(holding);
    for (const v of Object.values(node)) stack.push(v);
  }
  return legs;
}

/** True if the committed update CONSUMES `cid` — exercises or archives it — as
 * opposed to merely creating or referencing it. An accept or a withdraw consumes
 * the offer; the offer's own creation only creates it. Binding on consumption
 * (not mere reference) is what stops the offer's creation update — which carries
 * the same contract id and its transfer authorization — from standing in for the
 * acceptance that actually delivers. */
function updateConsumesContract(updateBody: string, cid: string): boolean {
  let root: unknown;
  try {
    root = JSON.parse(updateBody);
  } catch {
    return false;
  }
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    const n = node as Record<string, any>;
    for (const key of ['exercised_event', 'exercisedEvent', 'archived_event', 'archivedEvent']) {
      const ev = n[key];
      if (ev && typeof ev === 'object' && pickKey(ev, ['contract_id', 'contractId']) === cid) return true;
    }
    const et = pickKey(n, ['event_type', 'eventType']);
    if ((et === 'exercised_event' || et === 'archived_event') && pickKey(n, ['contract_id', 'contractId']) === cid) {
      return true;
    }
    for (const v of Object.values(n)) stack.push(v);
  }
  return false;
}

/**
 * The largest CC amount a committed update transfers from `sender` to `receiver`,
 * or null if none. Both parties and the instrument are bound structurally from
 * the transfer spec. When `agreementRef` is given, the transfer must also carry
 * that stream's `cantonstreams.dev/agreement` metadata, so an unrelated transfer
 * between the same two parties cannot be recorded as one of its cycles.
 */
function verifiedDelivery(
  updateBody: string,
  config: V1LaneConfig,
  expected: { sender: string; receiver: string; minAmount: number; agreementRef?: string },
): number | null {
  let best: number | null = null;
  for (const leg of collectDeliveryLegs(updateBody, config)) {
    if (!leg.instrumentOk) continue;
    if (leg.sender !== expected.sender || leg.receiver !== expected.receiver) continue;
    if (leg.amount + 1e-9 < expected.minAmount) continue;
    if (expected.agreementRef && leg.agreement !== expected.agreementRef) continue;
    if (best === null || leg.amount > best) best = leg.amount;
  }
  return best;
}

/**
 * Confirm a transfer committed on-ledger by looking it up on the global Scan
 * (`GET {registryApiUrl}/api/scan/v2/updates/{updateId}`) and structurally
 * binding it: the committed update must actually deliver the configured CC
 * instrument from `sender` to `receiver` for at least `minAmount`. Returns the
 * on-chain amount delivered, so callers credit the ledger, never a client claim.
 *
 * Why Scan and not our own participant: the payer's wallet submits on ITS
 * participant, and Canton privacy means the proxy generally never witnesses the
 * transfer. Scan ingests every committed update, so it is the one vantage point
 * that can see it. Polls briefly to absorb Scan ingestion lag.
 */
export async function verifyDeliveryOnScan(
  config: V1LaneConfig,
  updateId: string,
  expected: { sender: string; receiver: string; minAmount: number; agreementRef?: string },
): Promise<{ body: string; amount: number }> {
  const body = await fetchCommittedUpdate(config, updateId);
  const amount = verifiedDelivery(body, config, expected);
  if (amount === null) {
    throw new V1LaneError(
      422,
      'settlement_mismatch',
      `update ${updateId} committed on chain but delivers no ${config.instrumentId} of at least ${expected.minAmount} from ` +
        `${expected.sender.split('::')[0]} to ${expected.receiver.split('::')[0]}; refusing to record.`,
    );
  }
  return { body, amount };
}

/** Fetch a committed update from the global Scan, polling briefly to absorb
 * ingestion lag, and confirm it echoes the requested id. Returns the raw body. */
async function fetchCommittedUpdate(config: V1LaneConfig, updateId: string): Promise<string> {
  const url = `${config.registryApiUrl}/api/scan/v2/updates/${encodeURIComponent(updateId)}`;
  const attempts = 8;
  const delayMs = 2500;
  let lastNote = 'no response';
  for (let i = 0; i < attempts; i++) {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      lastNote = `fetch error: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
      await v1Sleep(delayMs);
      continue;
    }
    if (res.status === 404) {
      lastNote = 'not yet on Scan';
      await v1Sleep(delayMs);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      lastNote = `Scan ${res.status}: ${text.slice(0, 120)}`;
      await v1Sleep(delayMs);
      continue;
    }
    let parsed: { update_id?: string; updateId?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
    if ((parsed.update_id ?? parsed.updateId) !== updateId) {
      throw new V1LaneError(422, 'settlement_mismatch', `update ${updateId} on Scan does not echo the requested id.`);
    }
    return text;
  }
  throw new V1LaneError(
    422,
    'settlement_unverified',
    `update ${updateId} is not confirmed on Scan after ${(attempts * delayMs) / 1000}s (${lastNote}); nothing was recorded.`,
  );
}

/**
 * Confirm a pending offer was consummated in favour of `recipient`: the committed
 * update must reference the exact tracked offer contract (so an unrelated update
 * can't stand in for it) and create at least `minAmount` of the configured CC as a
 * holding in the recipient's name. Only a created holding counts as delivery — a
 * transfer-spec leg is the transfer's authorization, which is also present in the
 * offer's own creation update, so counting it would let that creation update be
 * replayed as an acceptance for funds that are only locked, never delivered.
 * Returns the on-chain amount delivered, so the caller credits the ledger rather
 * than a stored figure.
 */
async function verifyConsummationOnScan(
  config: V1LaneConfig,
  updateId: string,
  expected: { trackedCid?: string; recipient: string; minAmount: number },
): Promise<{ body: string; amount: number }> {
  // Fail closed: a credit path must bind to a specific offer contract. Without
  // one it would fall back to receiver+amount only, so an unrelated delivery of
  // at least the amount to the recipient could consummate the cycle.
  if (!expected.trackedCid) {
    throw new V1LaneError(
      422,
      'settlement_mismatch',
      `no tracked offer contract to bind update ${updateId} to; refusing to record.`,
    );
  }
  const body = await fetchCommittedUpdate(config, updateId);
  if (!updateConsumesContract(body, expected.trackedCid)) {
    throw new V1LaneError(
      422,
      'settlement_mismatch',
      `update ${updateId} does not consume the tracked offer; refusing to record.`,
    );
  }
  let best: number | null = null;
  for (const leg of collectDeliveryLegs(body, config)) {
    // Delivery is a created holding (no sender); a sender-bearing transfer-spec
    // leg is only the authorization and is present at offer creation too.
    if (leg.sender != null) continue;
    if (!leg.instrumentOk || leg.receiver !== expected.recipient) continue;
    if (leg.amount + 1e-9 < expected.minAmount) continue;
    if (best === null || leg.amount > best) best = leg.amount;
  }
  if (best === null) {
    throw new V1LaneError(
      422,
      'settlement_mismatch',
      `update ${updateId} creates no ${config.instrumentId} holding of at least ${expected.minAmount} for ` +
        `${expected.recipient.split('::')[0]}; refusing to record.`,
    );
  }
  return { body, amount: best };
}

/**
 * Confirm a committed update actually DELIVERED at least `minAmount` of the
 * configured CC to `recipient` as a created holding — used to verify a funding
 * deposit into the escrow custody party. Only a created holding counts, never a
 * transfer-spec (authorization) leg, so a locked-but-undelivered transfer
 * instruction (a pending offer the sender can still withdraw) can't be recorded
 * as a funded deposit and phantom-inflate the pool's owed balance. Returns the
 * on-chain amount delivered.
 */
export async function verifyHoldingDeliveryOnScan(
  config: V1LaneConfig,
  updateId: string,
  expected: { recipient: string; minAmount: number },
): Promise<{ body: string; amount: number }> {
  const body = await fetchCommittedUpdate(config, updateId);
  let best: number | null = null;
  for (const leg of collectDeliveryLegs(body, config)) {
    if (leg.sender != null) continue;
    if (!leg.instrumentOk || leg.receiver !== expected.recipient) continue;
    if (leg.amount + 1e-9 < expected.minAmount) continue;
    if (best === null || leg.amount > best) best = leg.amount;
  }
  if (best === null) {
    throw new V1LaneError(
      422,
      'deposit_undelivered',
      `update ${updateId} creates no ${config.instrumentId} holding of at least ${expected.minAmount} for ` +
        `${expected.recipient.split('::')[0]}; refusing to record the deposit.`,
    );
  }
  return { body, amount: best };
}

/** Confirm a committed update consumed a specific offer contract. Used for a
 * withdraw, which reclaims funds rather than delivering them, so there is nothing
 * to credit — only the tracked offer's consumption to confirm, so a stray update
 * can't mark the wrong offer withdrawn. */
async function verifyContractConsumedOnScan(
  config: V1LaneConfig,
  updateId: string,
  cid?: string,
): Promise<string> {
  const body = await fetchCommittedUpdate(config, updateId);
  // Fail closed: without a tracked offer to bind to there is nothing to confirm,
  // so refuse rather than accept any committed update.
  if (!cid) {
    throw new V1LaneError(
      422,
      'settlement_mismatch',
      `no tracked offer contract to bind update ${updateId} to; refusing to record.`,
    );
  }
  if (!updateConsumesContract(body, cid)) {
    throw new V1LaneError(
      422,
      'settlement_mismatch',
      `update ${updateId} does not consume the withdrawn offer; refusing to record.`,
    );
  }
  return body;
}

/**
 * Inspect a committed Scan update for a freshly-CREATED TransferInstruction.
 *
 * A cycle's `TransferFactory_Transfer` has two on-chain outcomes:
 *   - receiver HAS pre-approval → the transfer completes; no instruction is
 *     created (the receiver simply gets new holdings).
 *   - receiver has NO pre-approval → a `TransferInstruction` is created that the
 *     receiver must accept.
 * This walks the update tree for a created event whose template id names
 * "TransferInstruction" (and carries create arguments, so it is a CREATE, not
 * an exercise) and returns that contract id — the offer Bob will accept. The
 * created-args guard is what distinguishes it from the exercise node that
 * merely references the interface. Returns undefined for the direct-delivery
 * case, in which the caller records a normal settled cycle.
 */
function findCreatedInstructionCid(updateBody: string): string | undefined {
  let root: unknown;
  try {
    root = JSON.parse(updateBody);
  } catch {
    return undefined;
  }
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    const obj = node as Record<string, unknown>;
    const tid = obj['template_id'] ?? obj['templateId'];
    const cid = obj['contract_id'] ?? obj['contractId'];
    const hasCreateArgs =
      obj['create_arguments'] !== undefined ||
      obj['createArguments'] !== undefined ||
      obj['createArgument'] !== undefined;
    // A pending offer's contract is CC's `…:AmuletTransferInstruction` or a
    // registry asset's `…:Transfer:TransferOffer` (USDCx). Match either, else a
    // non-CC offer is mis-recorded as a direct delivery and never reclaimed.
    if (
      typeof tid === 'string' &&
      (tid.includes('TransferInstruction') || tid.includes('TransferOffer')) &&
      typeof cid === 'string' &&
      cid.length > 0 &&
      hasCreateArgs
    ) {
      return cid;
    }
    for (const v of Object.values(obj)) stack.push(v);
  }
  return undefined;
}

interface Holding {
  cid: string;
  amount: number;
}

async function senderHoldings(
  config: V1LaneConfig,
  party: string,
  holdingTemplateId?: string,
): Promise<Holding[]> {
  const { offset } = await ledger(config, 'GET', '/v2/state/ledger-end');
  const rows: any[] = await ledger(config, 'POST', '/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: holdingTemplateId || config.holdingTemplateId,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: offset,
  });
  return rows
    .map((r) => r.contractEntry?.JsActiveContract)
    .filter(Boolean)
    .filter((a) => a.createdEvent.createArgument.owner === party)
    // A locked holding can't be a transfer input (it's collateral in a pending
    // transfer/allocation). Amulet has no such field so CC is unaffected; a
    // registry holding (USDCx) sets `lock` while locked.
    .filter((a) => a.createdEvent.createArgument.lock == null)
    .map((a) => {
      // Amulet nests the spendable figure as amount.initialAmount; a registry
      // holding (USDCx) carries a flat decimal string. Tolerate both.
      const amt = a.createdEvent.createArgument.amount;
      const n = amt && typeof amt === 'object' ? Number(amt.initialAmount ?? 0) : Number(amt ?? 0);
      return { cid: a.createdEvent.contractId, amount: n };
    });
}

interface OnLedgerInstruction {
  cid: string;
  amount: string;
  executeBefore?: string;
  ref?: string;
}

/**
 * Active AmuletTransferInstructions this participant witnesses for `recipient`,
 * optionally filtered to those `sender` created. Used to RECOVER a pending offer
 * that committed on-ledger but whose record was lost — e.g. the payer's wallet
 * threw a (false) rejection AFTER the transfer committed (observed with Loop).
 * Only returns contracts genuinely active on-ledger, so recovery stays truthful.
 */
async function activeTransferInstructions(
  config: V1LaneConfig,
  recipient: string,
  sender?: string,
): Promise<OnLedgerInstruction[]> {
  const { offset } = await ledger(config, 'GET', '/v2/state/ledger-end');
  const rows: any[] = await ledger(config, 'POST', '/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [recipient]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId:
                      '#splice-amulet:Splice.AmuletTransferInstruction:AmuletTransferInstruction',
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: offset,
  });
  return rows
    .map((r) => r.contractEntry?.JsActiveContract?.createdEvent)
    .filter(Boolean)
    .map((ev: any) => ({ ev, tr: ev.createArgument?.transfer ?? {} }))
    .filter(({ tr }: any) => !sender || tr.sender === sender)
    .map(({ ev, tr }: any) => ({
      cid: ev.contractId,
      amount: String(tr.amount ?? '0'),
      executeBefore: tr.executeBefore,
      ref: tr.meta?.values?.['cantonstreams.dev/ref'],
    }));
}

// ---------------------------------------------------------------------------
// Received / incoming transfers (ledger-backed, store-independent)
//
// The proxy JSON store only knows about streams it created. A recipient's real
// picture — pending offers awaiting their accept, and CC already delivered —
// lives on the ledger, so these read the participant directly and work for ANY
// transfer to the party (proxy-created, raw registry, or wallet-sent), which
// the stream list cannot surface.
// ---------------------------------------------------------------------------

/** A pending AmuletTransferInstruction awaiting the recipient's accept. */
export interface ReceivedPendingOffer {
  transferInstructionCid: string;
  amount: string;
  sender: string;
  instrumentId: string;
  requestedAt?: string;
  executeBefore?: string;
  /** True once `executeBefore` has passed: the on-ledger accept deadline is
   *  baked into the instruction, so an expired offer can no longer be accepted —
   *  the sender must withdraw + re-send. Surfaced so the UI can disable Accept. */
  expired: boolean;
}

/** CC already delivered to the recipient (an accepted incoming transfer). */
export interface ReceivedTransfer {
  updateId: string;
  amount: string;
  at: string;
}

export interface ReceivedView {
  party: string;
  pending: ReceivedPendingOffer[];
  received: ReceivedTransfer[];
}

const AMULET_TEMPLATE_RE = /:Splice\.Amulet:Amulet$/;
const TRANSFER_INSTRUCTION_RE = /TransferInstruction/;

/** Active incoming offers: AmuletTransferInstruction where the caller is the
 *  transfer receiver. Unlike `activeTransferInstructions`, this is NOT scoped
 *  to a payer/stream — it surfaces every pending offer to the party. */
/** The `transfer` record off a pending offer, whichever shape the ACS returned:
 *  the concrete Amulet template exposes it as `createArgument.transfer`; a non-CC
 *  token surfaces through the standardized TransferInstruction interface view. */
function offerTransfer(ev: any): any {
  if (ev?.createArgument?.transfer) return ev.createArgument.transfer;
  for (const v of (ev?.interfaceViews ?? [])) {
    if (v?.viewValue?.transfer) return v.viewValue.transfer;
  }
  return {};
}

async function incomingOffers(config: V1LaneConfig, party: string): Promise<ReceivedPendingOffer[]> {
  const { offset } = await ledger(config, 'GET', '/v2/state/ledger-end');
  // CC always uses its exact, proven template filter. Only when a non-CC asset is
  // actually whitelisted do we add the standardized TransferInstruction interface
  // filters (by package NAME — the ACS requires it) so a non-CC pending offer
  // surfaces without needing its concrete template id up front. This keeps the
  // CC-only inbox byte-for-byte the pre-multi-asset query.
  const cumulative: unknown[] = [
    {
      identifierFilter: {
        TemplateFilter: {
          value: {
            templateId: '#splice-amulet:Splice.AmuletTransferInstruction:AmuletTransferInstruction',
            includeCreatedEventBlob: false,
          },
        },
      },
    },
  ];
  if (getSupportedAssets().some((a) => a.key !== 'cc')) {
    for (const interfaceId of [TI_INTERFACE_NAME_V1, TI_INTERFACE_NAME_V2]) {
      cumulative.push({
        identifierFilter: {
          InterfaceFilter: { value: { interfaceId, includeInterfaceView: true, includeCreatedEventBlob: false } },
        },
      });
    }
  }
  const rows: any[] = await ledger(config, 'POST', '/v2/state/active-contracts', {
    filter: { filtersByParty: { [party]: { cumulative } } },
    verbose: false,
    activeAtOffset: offset,
  });
  const byCid = new Map<string, ReceivedPendingOffer>();
  for (const r of rows) {
    const ev = r.contractEntry?.JsActiveContract?.createdEvent;
    if (!ev) continue;
    const tr = offerTransfer(ev);
    if (tr.receiver !== party) continue;
    byCid.set(ev.contractId, {
      transferInstructionCid: ev.contractId,
      amount: String(tr.amount ?? '0'),
      sender: String(tr.sender ?? ''),
      instrumentId:
        tr.instrumentId && typeof tr.instrumentId === 'object'
          ? String(tr.instrumentId.id ?? 'Amulet')
          : String(tr.instrumentId ?? 'Amulet'),
      requestedAt: tr.requestedAt,
      executeBefore: tr.executeBefore,
      expired: !!tr.executeBefore && Date.parse(tr.executeBefore) < Date.now(),
    });
  }
  return [...byCid.values()];
}

/** Delivered receipts: walk the party's flat update history and collect the
 *  Amulet(owner==party) creates that landed in a transaction which also
 *  archived an AmuletTransferInstruction — i.e. an accepted incoming transfer.
 *  (Change outputs from the party's own spends archive+create Amulets WITHOUT a
 *  TransferInstruction archive, so they are excluded.) */
/**
 * Fetch every flat update for `party` in `[0, end]`. The JSON Ledger API caps
 * a single `/v2/updates/flats` response at 200 elements (and returns HTTP 413
 * rather than truncating), so a party with a long history — e.g. a high-volume
 * operator — cannot be read in one call. This walks the offset range in
 * windows, halving the window on a 413 and advancing (and gently growing it) on
 * success, so the read completes for any party regardless of history size.
 */
async function fetchPartyUpdates(config: V1LaneConfig, party: string, end: number): Promise<any[]> {
  const filter = {
    filtersByParty: {
      [party]: {
        cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }],
      },
    },
  };
  const all: any[] = [];
  let begin = 0;
  let window = Math.max(1, end);
  for (let guard = 0; begin < end && guard < 100000; guard++) {
    const endInclusive = Math.min(end, begin + window);
    try {
      const body = await ledger(config, 'POST', '/v2/updates/flats', {
        beginExclusive: begin,
        endInclusive,
        filter,
        verbose: false,
      });
      const rows: any[] = Array.isArray(body) ? body : (body.updates ?? []);
      all.push(...rows);
      begin = endInclusive;
      if (rows.length < 100 && window < end) window = Math.min(end - begin || 1, window * 2);
    } catch (e) {
      const msg = e instanceof V1LaneError ? e.message : String(e);
      if (/MAXIMUM_LIST_ELEMENTS|\b413\b/.test(msg) && window > 1) {
        window = Math.max(1, Math.floor(window / 2));
        continue;
      }
      throw e;
    }
  }
  return all;
}

async function receivedDeliveries(config: V1LaneConfig, party: string): Promise<ReceivedTransfer[]> {
  const { offset } = await ledger(config, 'GET', '/v2/state/ledger-end');
  const rows: any[] = await fetchPartyUpdates(config, party, Number(offset));
  const out: ReceivedTransfer[] = [];
  for (const row of rows) {
    const tx = row?.update?.Transaction?.value;
    if (!tx) continue;
    const events: any[] = tx.events ?? [];
    let archivedOffer = false;
    let amount = 0;
    for (const ev of events) {
      const arch = ev.ArchivedEvent ?? ev.ExercisedEvent;
      if (arch && TRANSFER_INSTRUCTION_RE.test(String(arch.templateId ?? ''))) archivedOffer = true;
      const ce = ev.CreatedEvent;
      if (ce && AMULET_TEMPLATE_RE.test(String(ce.templateId ?? '')) && ce.createArgument?.owner === party) {
        amount += Number(ce.createArgument?.amount?.initialAmount ?? 0);
      }
    }
    if (archivedOffer && amount > 0) {
      out.push({ updateId: tx.updateId, amount: amount.toFixed(10), at: tx.effectiveAt });
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // newest first
  return out;
}

/** Build + submit a TransferInstruction_Accept for a raw offer cid (no stream
 *  record required). The party must be the offer's receiver — enforced here for
 *  a clean error, and again on-ledger at submit. */
async function prepareAcceptOfferByCid(
  config: V1LaneConfig,
  party: string,
  transferInstructionCid: string,
  registryBaseUrl?: string,
): Promise<PreparedInstructionAction & { amount: string; sender: string }> {
  const offer = (await incomingOffers(config, party)).find(
    (o) => o.transferInstructionCid === transferInstructionCid,
  );
  if (!offer) {
    throw new V1LaneError(404, 'offer_not_found', 'No active incoming offer with that id for this party');
  }
  if (offer.expired) {
    // The accept-by deadline is enforced on-ledger (deadline-exceeded), so
    // catch it here for a clean message instead of a raw ledger 500.
    throw new V1LaneError(
      409,
      'offer_expired',
      `This transfer offer expired at ${offer.executeBefore} and can no longer be accepted. Ask the sender to re-send it.`,
    );
  }
  const record: PendingTransferRecord = {
    cycle: 0,
    amount: offer.amount,
    ref: `received:${transferInstructionCid.slice(0, 12)}`,
    transferInstructionCid,
    executeBefore:
      offer.executeBefore ?? new Date(Date.now() + config.executeBeforeSeconds * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  const prepared = await prepareInstructionActionCommand(config, record, 'accept', party, registryBaseUrl);
  return { ...prepared, amount: offer.amount, sender: offer.sender };
}

/** Model 1 (hosted party): proxy forms AND submits the accept. `registryBaseUrl`
 *  selects the per-asset registrar for the accept choice-context; omit for CC. */
export async function acceptOfferByCid(
  config: V1LaneConfig,
  party: string,
  transferInstructionCid: string,
  registryBaseUrl?: string,
): Promise<{ updateId: string; amount: string; sender: string }> {
  const prepared = await prepareAcceptOfferByCid(config, party, transferInstructionCid, registryBaseUrl);
  const res = await submit(config, 'recv-accept', [party], [prepared.command], prepared.disclosedContracts as unknown[]);
  const updateId = (res?.updateId ?? res?.transactionTree?.updateId) as string | undefined;
  if (!updateId) {
    throw new V1LaneError(502, 'submit_no_update', 'accept submitted but the ledger returned no updateId');
  }
  return { updateId, amount: prepared.amount, sender: prepared.sender };
}

/**
 * The escrow's matching pending offer for a wallet-signed non-CC deposit. It must
 * be incoming to the escrow, sent by the declared payer, of the declared
 * instrument, unexpired, and cover the amount — so a caller can never bind a third
 * party's offer or a different asset. Returns undefined when none matches (caller
 * then fails closed).
 */
export async function findEscrowDepositOffer(
  config: V1LaneConfig,
  opts: { expectedSender: string; instrumentId: string; minAmount: number },
): Promise<ReceivedPendingOffer | undefined> {
  const escrow = config.escrowParty;
  if (!escrow) return undefined;
  const offers = await incomingOffers(config, escrow);
  const matches = offers.filter(
    (o) =>
      o.sender === opts.expectedSender &&
      String(o.instrumentId) === opts.instrumentId &&
      !o.expired &&
      Number(o.amount) + 1e-6 >= opts.minAmount,
  );
  // Prefer the closest-amount offer (this deposit's own offer is formed for
  // exactly its amount), then the freshest, so a new deposit binds its own offer
  // rather than an older larger one that would over-fund the vault.
  matches.sort((a, b) => {
    const da = Math.abs(Number(a.amount) - opts.minAmount);
    const db = Math.abs(Number(b.amount) - opts.minAmount);
    if (Math.abs(da - db) > 1e-6) return da - db;
    return String(a.requestedAt ?? '') < String(b.requestedAt ?? '') ? 1 : -1;
  });
  return matches[0];
}

/**
 * Sum the holdings the escrow OWNS and can spend (owner === escrow, unlocked) of a
 * given concrete holding template. Used to credit a non-CC deposit by the amount
 * the escrow's own participant confirms it actually received — never a client
 * claim. Tolerates the Amulet-nested and flat (registry) `amount` shapes.
 */
export async function escrowOwnedHoldings(
  config: V1LaneConfig,
  holdingTemplateId: string,
): Promise<number> {
  if (!config.escrowParty || !holdingTemplateId) return 0;
  const { offset } = await ledger(config, 'GET', '/v2/state/ledger-end');
  const rows: any[] = await ledger(config, 'POST', '/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [config.escrowParty]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: { value: { templateId: holdingTemplateId, includeCreatedEventBlob: false } },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: offset,
  });
  let sum = 0;
  for (const r of rows) {
    const a = r.contractEntry?.JsActiveContract?.createdEvent?.createArgument;
    if (!a || a.lock != null || String(a.owner) !== config.escrowParty) continue;
    const amt = a.amount;
    sum += amt && typeof amt === 'object' ? Number(amt.initialAmount ?? 0) : Number(amt ?? 0);
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Accrual + policy (ported from interest-stream-scheduler.mjs:224-241)
// ---------------------------------------------------------------------------

/** Stepped accrual since effectiveFrom, capped at termEnd. */
export function accruedAmount(agreement: V1Agreement, nowMs: number): number {
  const period = PERIOD_MS[agreement.cadence];
  if (!period) throw new V1LaneError(400, 'invalid_cadence', `agreement ${agreement.agreementId}: invalid cadence`);
  const start = Date.parse(agreement.effectiveFrom);
  const end = agreement.termEnd ? Date.parse(agreement.termEnd) : Infinity;
  const elapsed = Math.min(nowMs, end) - start;
  if (elapsed < period) return 0;
  return Math.floor(elapsed / period) * Number(agreement.ratePerPeriod);
}

/** Amount due this tick per the agreement's arrears policy. */
export function dueAmount(agreement: V1Agreement, settled: number, nowMs: number): number {
  if (agreement.status === 'stopped') return 0;
  const arrears = Number((accruedAmount(agreement, nowMs) - settled).toFixed(10));
  if (arrears <= 0) return 0;
  if ((agreement.arrearsPolicy ?? 'catch-up') === 'catch-up') return arrears;
  // skip-missed: pay at most one period per tick; older windows lapse.
  return Math.min(arrears, Number(agreement.ratePerPeriod));
}

// ---------------------------------------------------------------------------
// Settlement (ported verbatim from interest-stream-scheduler.mjs:247-328)
// ---------------------------------------------------------------------------

export interface SettleResult {
  ref: string;
  updateId: string;
  /** transfer.executeBefore — a pending offer's on-ledger acceptance deadline. */
  executeBefore?: string;
  /** Set when the transfer committed as a pending (undelivered) offer — a
   * `TransferInstruction` the receiver must accept (no pre-approval). */
  pendingInstructionCid?: string;
}

/** A holding the payer will spend this cycle: contract id + decimal amount. */
export interface HoldingInput {
  cid: string;
  amount: number;
}

/** The fully-formed, ready-to-submit TransferFactory_Transfer for one cycle —
 * the command + disclosed contracts + the party that must sign. This is the
 * unit both model 1 (proxy submits) and model 2 (the payer's wallet submits)
 * share. Building it requires the registry choice-context (whitelisted egress),
 * which is why it always happens on the proxy. */
export interface PreparedSettle {
  ref: string;
  cycle: number;
  amount: string;
  /** transfer.executeBefore — the offer's expiry if it lands as a pending instruction. */
  executeBefore: string;
  actAs: string;
  command: unknown;
  disclosedContracts: unknown[];
}

/** A ready-to-submit Accept/Withdraw of a pending TransferInstruction. */
export interface PreparedInstructionAction {
  ref: string;
  cycle: number;
  amount: string;
  transferInstructionCid: string;
  actAs: string;
  command: unknown;
  disclosedContracts: unknown[];
}

export interface PreparedAllocation {
  ref: string;
  cycle: number;
  amount: string;
  executor: string;
  unlockAt: string;
  expiresAt: string;
  actAs: string;
  command: unknown;
  disclosedContracts: unknown[];
}

export interface PreparedReceiverClaim {
  ref: string;
  cycle: number;
  amount: string;
  allocationCid: string;
  executor: string;
  unlockAt: string;
  expiresAt: string;
  actAs: string;
  command: unknown;
  disclosedContracts: unknown[];
}

export interface PreparedClaim {
  ref: string;
  cycle: number;
  amount: string;
  allocationCid: string;
  receiverClaimCid: string;
  actAs: string;
  command: unknown;
  disclosedContracts: unknown[];
}

function streamMeta(agreement: V1Agreement, ref: string): { values: Record<string, string> } {
  return {
    values: {
      'cantonstreams.dev/ref': ref,
      'cantonstreams.dev/v': '1',
      ...(agreement.appId ? { 'cantonstreams.dev/app': agreement.appId } : {}),
      'cantonstreams.dev/agreement': agreement.agreementId,
    },
  };
}

function assertIsoTime(value: string, field: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new V1LaneError(400, 'invalid_time', `${field} must be an ISO-8601 timestamp`);
  }
  return new Date(ms).toISOString();
}

function claimRecords(state: V1StreamState): ReceiverClaimRecord[] {
  if (!state.receiverClaims) state.receiverClaims = [];
  return state.receiverClaims;
}

function pendingRecords(state: V1StreamState): PendingTransferRecord[] {
  if (!state.pendingTransfers) state.pendingTransfers = [];
  return state.pendingTransfers;
}

/** Select a pending transfer offer by cid (preferred) or cycle, else the
 * oldest still-`pending` one. */
function selectPendingRecord(
  state: V1StreamState,
  selector: { transferInstructionCid?: string; cycle?: number },
): PendingTransferRecord | undefined {
  const rows = pendingRecords(state);
  if (selector.transferInstructionCid) {
    return rows.find((r) => r.transferInstructionCid === selector.transferInstructionCid);
  }
  if (selector.cycle !== undefined) {
    return rows.find((r) => r.cycle === selector.cycle);
  }
  return rows
    .filter((r) => r.status === 'pending')
    .sort((a, b) => a.cycle - b.cycle)[0];
}

function nextClaimCycle(state: V1StreamState): number {
  const claimed = state.cycles;
  const pendingMax = Math.max(0, ...claimRecords(state).map((r) => r.cycle));
  return Math.max(claimed, pendingMax) + 1;
}

function selectClaimRecord(
  state: V1StreamState,
  selector: { cycle?: number; receiverClaimCid?: string; allocationCid?: string },
): ReceiverClaimRecord | undefined {
  const rows = claimRecords(state);
  if (selector.receiverClaimCid) {
    return rows.find((r) => r.receiverClaimCid === selector.receiverClaimCid);
  }
  if (selector.allocationCid) {
    return rows.find((r) => r.allocationCid === selector.allocationCid);
  }
  if (selector.cycle !== undefined) {
    return rows.find((r) => r.cycle === selector.cycle);
  }
  return rows
    .filter((r) => r.status === 'claim_ready' && r.receiverClaimCid)
    .sort((a, b) => a.cycle - b.cycle)[0];
}

/**
 * Form the per-cycle TransferFactory_Transfer (registry choice-context + the
 * exercise command + disclosed contracts) WITHOUT submitting it. `holdings` may
 * be supplied by the caller (model 2: a wallet-held payer whose holdings live on
 * its own participant, so the proxy can't read them); otherwise they are read
 * from this participant's ACS (model 1: a payer this participant hosts).
 */
/** The per-stream settlement instrument, with every field resolved to a
 *  concrete value: the agreement's own instrument where present, else the
 *  proxy's global CC config. The concrete TransferInstruction/holding template
 *  for offers is NOT carried here — the registry returns it per-asset in each
 *  choice-context response, so it is read at exercise time. */
export interface ResolvedInstrument {
  admin: string;
  id: string;
  holdingTemplateId: string;
  registryApiUrl: string;
  transferVersion: 'v1' | 'v2';
  decimals: number;
}

/** Resolve a stream's effective settlement instrument. A stream created without
 *  an instrument (every CC stream today) resolves to the global config, so its
 *  money leg is byte-for-byte unchanged; a stream carrying a per-asset
 *  instrument settles that asset instead. */
export function resolveInstrument(
  config: V1LaneConfig,
  agreement: V1Agreement,
): ResolvedInstrument {
  const i = agreement.instrument;
  return {
    admin: i?.admin || config.ccAdminParty,
    id: i?.id || config.instrumentId,
    holdingTemplateId: i?.holdingTemplateId || config.holdingTemplateId,
    registryApiUrl: (i?.registryApiUrl || config.registryApiUrl).replace(/\/+$/, ''),
    transferVersion: i?.transferVersion || config.transferVersion,
    decimals: typeof i?.decimals === 'number' ? i.decimals : 10,
  };
}

/** A shallow copy of the lane config with the instrument-*identity* fields
 *  overridden to a stream's chosen asset, so the verify helpers (which read
 *  config.instrumentId / ccAdminParty / holdingTemplateId) match the right asset
 *  with no signature changes; a stream with no instrument yields config
 *  unchanged. `registryApiUrl` is deliberately NOT overridden: every asset
 *  settles on the same synchronizer, so on-chain confirmation is read from the
 *  one network Scan (config.registryApiUrl). The per-asset token-standard
 *  registry base is a separate concern, passed explicitly to the registry
 *  factory / choice-context calls (resolveInstrument().registryApiUrl). */
export function configForStream(config: V1LaneConfig, agreement: V1Agreement): V1LaneConfig {
  const inst = resolveInstrument(config, agreement);
  return {
    ...config,
    ccAdminParty: inst.admin,
    instrumentId: inst.id,
    holdingTemplateId: inst.holdingTemplateId,
    transferVersion: inst.transferVersion,
  };
}

export async function prepareSettleCommand(
  config: V1LaneConfig,
  agreement: V1Agreement,
  amount: number,
  cycleNo: number,
  holdingsIn?: HoldingInput[],
): Promise<PreparedSettle> {
  const ref = `${agreement.agreementId}:cycle-${cycleNo}`;
  const inst = resolveInstrument(config, agreement);
  const holdings =
    holdingsIn ?? (await senderHoldings(config, agreement.payerParty, inst.holdingTemplateId));
  const total = holdings.reduce((s, h) => s + h.amount, 0);
  if (total < amount) {
    throw new V1LaneError(
      402,
      'insufficient_funds',
      `insufficient funds: payer holds ≈${total.toFixed(4)}, cycle needs ${amount}`,
    );
  }
  const executeBefore = new Date(Date.now() + config.executeBeforeSeconds * 1000).toISOString();
  const transfer = {
    sender: agreement.payerParty,
    receiver: agreement.recipientParty,
    amount: amount.toFixed(10),
    instrumentId: { admin: inst.admin, id: inst.id },
    requestedAt: new Date(Date.now() - 1000).toISOString(),
    executeBefore,
    inputHoldingCids: holdings.map((h) => h.cid),
    meta: streamMeta(agreement, ref),
  };
  const fac = await registryPost(
    config,
    '/registry/transfer-instruction/v1/transfer-factory',
    {
      choiceArguments: {
        expectedAdmin: inst.admin,
        transfer,
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
      excludeDebugFields: true,
    },
    inst.registryApiUrl,
  );
  const ctx = fac.choiceContext ?? {};
  const disclosed = mapDisclosedContracts(ctx);
  const command = {
    ExerciseCommand: {
      templateId: config.transferFactoryInterfaceId,
      contractId: fac.factoryId,
      choice: 'TransferFactory_Transfer',
      choiceArgument: {
        expectedAdmin: inst.admin,
        transfer,
        extraArgs: {
          context: choiceContextValues(ctx),
          meta: { values: {} },
        },
      },
    },
  };
  return {
    ref,
    cycle: cycleNo,
    amount: amount.toFixed(10),
    executeBefore,
    actAs: agreement.payerParty,
    command,
    disclosedContracts: disclosed,
  };
}

/**
 * v2 variant of {@link prepareSettleCommand} — the token-standard v2
 * direct-transfer money leg (proven live). Differs from v1 in exactly three
 * ways, per the CIP-56 v2 interface: (1) the registry path is `/v2/…`;
 * (2) `TransferFactory_Transfer` drops `expectedAdmin` for `actors : [Party]`
 * (`controller actors`); (3) `Transfer.sender`/`.receiver` are `Account`
 * records `{ owner, provider, id }`, not bare parties. Everything else — the
 * transfer body, disclosed-contract mapping, and single-signed submit — is
 * identical, so callers can pick the version without changing the flow.
 */
export async function prepareSettleCommandV2(
  config: V1LaneConfig,
  agreement: V1Agreement,
  amount: number,
  cycleNo: number,
  holdingsIn?: HoldingInput[],
): Promise<PreparedSettle> {
  const ref = `${agreement.agreementId}:cycle-${cycleNo}`;
  const inst = resolveInstrument(config, agreement);
  const holdings =
    holdingsIn ?? (await senderHoldings(config, agreement.payerParty, inst.holdingTemplateId));
  const total = holdings.reduce((s, h) => s + h.amount, 0);
  if (total < amount) {
    throw new V1LaneError(
      402,
      'insufficient_funds',
      `insufficient funds: payer holds ≈${total.toFixed(4)}, cycle needs ${amount}`,
    );
  }
  const executeBefore = new Date(Date.now() + config.executeBeforeSeconds * 1000).toISOString();
  // v2 Account records: self-custodied holding → owner-only account.
  const account = (owner: string) => ({ owner, provider: null, id: '' });
  const transfer = {
    sender: account(agreement.payerParty),
    receiver: account(agreement.recipientParty),
    amount: amount.toFixed(10),
    instrumentId: { admin: inst.admin, id: inst.id },
    requestedAt: new Date(Date.now() - 5000).toISOString(),
    executeBefore,
    inputHoldingCids: holdings.map((h) => h.cid),
    meta: streamMeta(agreement, ref),
  };
  const fac = await registryPost(
    config,
    '/registry/transfer-instruction/v2/transfer-factory',
    {
      choiceArguments: {
        transfer,
        actors: [agreement.payerParty],
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
      excludeDebugFields: true,
    },
    inst.registryApiUrl,
  );
  const ctx = fac.choiceContext ?? {};
  const disclosed = mapDisclosedContracts(ctx);
  const command = {
    ExerciseCommand: {
      templateId: config.transferFactoryInterfaceIdV2,
      contractId: fac.factoryId,
      choice: 'TransferFactory_Transfer',
      choiceArgument: {
        transfer,
        actors: [agreement.payerParty],
        extraArgs: { context: choiceContextValues(ctx), meta: { values: {} } },
      },
    },
  };
  return {
    ref,
    cycle: cycleNo,
    amount: amount.toFixed(10),
    executeBefore,
    actAs: agreement.payerParty,
    command,
    disclosedContracts: disclosed,
  };
}

/**
 * Form a V1 AllocationFactory_Allocate for the receiver-claim path.
 *
 * Controlled-validator default is `executor == recipient`: then ReceiverClaimV1.Claim's
 * controller set (`recipient, executor`) collapses to the recipient alone, so
 * Bob can claim from his wallet without Alice or an operator co-signing each
 * cycle. This still requires `canton-streams-v1-shim` to be vetted on the
 * participant that created ReceiverClaimV1. The on-ledger `unlockAt` check
 * remains the time gate.
 */
async function prepareReceiverAllocationCommand(
  config: V1LaneConfig,
  agreement: V1Agreement,
  params: {
    amount: number;
    cycleNo: number;
    holdings?: HoldingInput[];
    executor?: string;
    unlockAt?: string;
    expiresAt?: string;
  },
): Promise<PreparedAllocation> {
  const ref = `${agreement.agreementId}:cycle-${params.cycleNo}`;
  const holdings = params.holdings ?? (await senderHoldings(config, agreement.payerParty));
  const total = holdings.reduce((s, h) => s + h.amount, 0);
  if (total < params.amount) {
    throw new V1LaneError(
      402,
      'insufficient_funds',
      `insufficient funds: payer holds ≈${total.toFixed(4)}, cycle needs ${params.amount}`,
    );
  }

  const now = Date.now();
  const executor = params.executor ?? agreement.recipientParty;
  const defaultUnlock = new Date(
    Math.max(Date.parse(agreement.effectiveFrom) + PERIOD_MS[agreement.cadence] * params.cycleNo, now),
  ).toISOString();
  const unlockAt = assertIsoTime(params.unlockAt ?? defaultUnlock, 'unlockAt');
  const defaultExpires = new Date(Date.parse(unlockAt) + config.settleBeforeSeconds * 1000).toISOString();
  const expiresAt = assertIsoTime(params.expiresAt ?? defaultExpires, 'expiresAt');
  if (Date.parse(unlockAt) >= Date.parse(expiresAt)) {
    throw new V1LaneError(400, 'invalid_time_window', 'unlockAt must be before expiresAt');
  }

  const requestedAt = new Date(now - 1000).toISOString();
  const allocation = {
    settlement: {
      executor,
      settlementRef: { id: ref, cid: null },
      requestedAt,
      allocateBefore: new Date(now + config.allocateBeforeSeconds * 1000).toISOString(),
      settleBefore: expiresAt,
      meta: streamMeta(agreement, ref),
    },
    transferLegId: 'leg-1',
    transferLeg: {
      sender: agreement.payerParty,
      receiver: agreement.recipientParty,
      amount: params.amount.toFixed(10),
      instrumentId: { admin: config.ccAdminParty, id: config.instrumentId },
      meta: streamMeta(agreement, ref),
    },
  };

  const choiceArguments = {
    expectedAdmin: config.ccAdminParty,
    allocation,
    requestedAt,
    inputHoldingCids: holdings.map((h) => h.cid),
    extraArgs: { context: { values: {} }, meta: { values: {} } },
  };
  const fac = await registryPost(config, '/registry/allocation-instruction/v1/allocation-factory', {
    choiceArguments,
    excludeDebugFields: true,
  });
  const factoryId = fac.factoryId ?? fac.factory_id;
  if (!factoryId) {
    throw new V1LaneError(502, 'registry_error', 'allocation-factory response missing factoryId');
  }
  const ctx = fac.choiceContext ?? fac.choice_context ?? {};
  const command = {
    ExerciseCommand: {
      templateId: config.allocationFactoryInterfaceId,
      contractId: factoryId,
      choice: 'AllocationFactory_Allocate',
      choiceArgument: {
        ...choiceArguments,
        extraArgs: { context: choiceContextValues(ctx), meta: { values: {} } },
      },
    },
  };
  return {
    ref,
    cycle: params.cycleNo,
    amount: params.amount.toFixed(10),
    executor,
    unlockAt,
    expiresAt,
    actAs: agreement.payerParty,
    command,
    disclosedContracts: mapDisclosedContracts(ctx),
  };
}

function prepareReceiverClaimCreateCommand(
  config: V1LaneConfig,
  agreement: V1Agreement,
  record: ReceiverClaimRecord,
): PreparedReceiverClaim {
  const command = {
    CreateCommand: {
      templateId: config.receiverClaimTemplateId,
      createArguments: {
        streamId: agreement.agreementId,
        cycle: String(record.cycle),
        sender: agreement.payerParty,
        recipient: agreement.recipientParty,
        executor: record.executor,
        allocationCid: record.allocationCid,
        expectedSettlementRef: record.ref,
        amount: record.amount,
        unlockAt: record.unlockAt,
        expiresAt: record.expiresAt,
        meta: streamMeta(agreement, record.ref),
      },
    },
  };
  return {
    ref: record.ref,
    cycle: record.cycle,
    amount: record.amount,
    allocationCid: record.allocationCid,
    executor: record.executor,
    unlockAt: record.unlockAt,
    expiresAt: record.expiresAt,
    actAs: agreement.payerParty,
    command,
    disclosedContracts: [],
  };
}

async function prepareReceiverClaimExerciseCommand(
  config: V1LaneConfig,
  record: ReceiverClaimRecord,
): Promise<PreparedClaim> {
  if (!record.receiverClaimCid) {
    throw new V1LaneError(409, 'claim_contract_missing', 'receiverClaimCid has not been recorded yet');
  }
  const body = await registryPost(
    config,
    `/registry/allocations/v1/${encodeURIComponent(record.allocationCid)}/choice-contexts/execute-transfer`,
    {},
  );
  const ctx = body.choiceContext ?? body.choice_context ?? body;
  const command = {
    ExerciseCommand: {
      templateId: config.receiverClaimTemplateId,
      contractId: record.receiverClaimCid,
      choice: 'Claim',
      choiceArgument: {
        extraArgs: { context: choiceContextValues(ctx), meta: { values: {} } },
      },
    },
  };
  return {
    ref: record.ref,
    cycle: record.cycle,
    amount: record.amount,
    allocationCid: record.allocationCid,
    receiverClaimCid: record.receiverClaimCid,
    actAs: record.executor,
    command,
    disclosedContracts: mapDisclosedContracts(ctx),
  };
}

/**
 * Form a TransferInstruction Accept (receiver) or Withdraw (sender) for a
 * pending offer, fetching the live registry choice-context + disclosures (the
 * registry call needs the validator's whitelisted egress, so it lives here).
 * The Daml choice is `TransferInstruction_Accept` / `TransferInstruction_Withdraw`;
 * the registry choice-context segment is the short kebab name (`accept` /
 * `withdraw`), mirroring the allocation `execute-transfer` pattern.
 */
async function prepareInstructionActionCommand(
  config: V1LaneConfig,
  record: PendingTransferRecord,
  action: 'accept' | 'withdraw',
  actAs: string,
  registryBaseUrl?: string,
): Promise<PreparedInstructionAction> {
  const choice = action === 'accept' ? 'TransferInstruction_Accept' : 'TransferInstruction_Withdraw';
  const body = await registryPost(
    config,
    `/registry/transfer-instruction/v1/${encodeURIComponent(record.transferInstructionCid)}/choice-contexts/${action}`,
    {},
    registryBaseUrl,
  );
  const ctx = body.choiceContext ?? body.choice_context ?? body;
  const command = {
    ExerciseCommand: {
      templateId: config.transferInstructionInterfaceId,
      contractId: record.transferInstructionCid,
      choice,
      choiceArgument: {
        extraArgs: { context: choiceContextValues(ctx), meta: { values: {} } },
      },
    },
  };
  return {
    ref: record.ref,
    cycle: record.cycle,
    amount: record.amount,
    transferInstructionCid: record.transferInstructionCid,
    actAs,
    command,
    disclosedContracts: mapDisclosedContracts(ctx),
  };
}

/**
 * Build (no submit) a `TransferInstruction_Withdraw` for the offer's SENDER to
 * reclaim the locked funds of a still-pending offer by its contract id. The
 * sender's withdraw maps to the unguarded abort path, so it is exercisable at
 * any time including after `executeBefore` — this is how a stuck, expired,
 * unaccepted offer's funds are recovered when the receiver has no preapproval.
 * `registryBaseUrl` selects the per-asset registrar; omit for CC.
 */
export async function buildOfferWithdrawCommand(
  config: V1LaneConfig,
  transferInstructionCid: string,
  registryBaseUrl?: string,
): Promise<{ command: unknown; disclosedContracts: unknown[] }> {
  const body = await registryPost(
    config,
    `/registry/transfer-instruction/v1/${encodeURIComponent(transferInstructionCid)}/choice-contexts/withdraw`,
    {},
    registryBaseUrl,
  );
  const ctx = body.choiceContext ?? body.choice_context ?? body;
  const command = {
    ExerciseCommand: {
      templateId: config.transferInstructionInterfaceId,
      contractId: transferInstructionCid,
      choice: 'TransferInstruction_Withdraw',
      choiceArgument: { extraArgs: { context: choiceContextValues(ctx), meta: { values: {} } } },
    },
  };
  return { command, disclosedContracts: mapDisclosedContracts(ctx) };
}

/** Model 1: the proxy forms AND submits the transfer (payer hosted here). */
export async function settleCycle(
  config: V1LaneConfig,
  agreement: V1Agreement,
  amount: number,
  cycleNo: number,
): Promise<SettleResult> {
  const prepareFn =
    resolveInstrument(config, agreement).transferVersion === 'v2'
      ? prepareSettleCommandV2
      : prepareSettleCommand;
  const prepared = await prepareFn(config, agreement, amount, cycleNo);
  // This is the one place the operator participant submits a transfer with a
  // party's own authority (actAs=[payerParty]). Refuse to do so for a co-hosted
  // party unless custody is disclosed.
  await assertNotUndisclosedCustody(config, agreement.payerParty, prepared.ref);
  // Submit for the transaction TREE so we can classify the outcome atomically
  // (no Scan-ingestion lag, so no double-pay risk): a created TransferInstruction
  // means the receiver had no pre-approval, so the transfer is a pending offer
  // (funds locked, NOT delivered) rather than a completed delivery.
  const res = await ledger(config, 'POST', '/v2/commands/submit-and-wait-for-transaction-tree', {
    commands: [prepared.command],
    // Deterministic per (agreement, cycle) so a crash between the committed
    // transfer and the persisted state does not re-pay on restart: Canton
    // deduplicates a replay of the same committed commandId. The agreementId is
    // the stream id for a direct settle and `${escrowId}:release|deposit` for an
    // escrow cycle, so each logical cycle has its own stable id.
    commandId: `proxy-v1-xfer-${agreement.agreementId}-${cycleNo}`,
    actAs: [agreement.payerParty],
    readAs: [],
    ...(config.userId ? { userId: config.userId } : {}),
    ...(prepared.disclosedContracts.length ? { disclosedContracts: prepared.disclosedContracts } : {}),
  });
  const tree = res.transactionTree ?? res.transaction ?? res;
  const updateId = tree?.updateId ?? res?.updateId ?? 'n/a';
  const pendingInstructionCid = findCreatedInstructionCid(JSON.stringify(tree ?? res));
  return {
    ref: prepared.ref,
    updateId,
    executeBefore: prepared.executeBefore,
    ...(pendingInstructionCid ? { pendingInstructionCid } : {}),
  };
}

/**
 * Resolve the CURRENT StreamAdmin cid for an agreement by streamId.
 * Sync_Iteration consumes and recreates the contract, so any stored cid
 * goes stale after one sync — the ACS is the only reliable source.
 */
async function resolveStreamAdminCid(
  config: V1LaneConfig,
  agreement: V1Agreement,
): Promise<string | undefined> {
  const cid = await resolveStreamAdminEvent(
    config,
    agreement.payerParty,
    agreement.agreementId,
    agreement.recipientParty,
  );
  return cid?.contractId;
}

interface StreamAdminEvent {
  contractId: string;
  createArgument: any;
}

/**
 * Read the live StreamAdmin createEvent for a stream. Stream ids are
 * caller-supplied and NOT globally unique, so a streamId-only match can resolve
 * a different stream's admin contract that `party` happens to observe. Pin the
 * match to the full identity (streamId + sender + recipient), take the
 * most-progressed chain, and tie-break deterministically on operator.
 */
async function resolveStreamAdminEvent(
  config: V1LaneConfig,
  party: string,
  streamId: string,
  recipient?: string,
): Promise<StreamAdminEvent | undefined> {
  // ACS filters take package-NAME ids; commands take pinned package ids.
  const parts = config.streamAdminTemplateId.split(':');
  const mod = parts[1];
  const ent = parts[2];
  const filterId = config.streamAdminTemplateId.startsWith('#')
    ? config.streamAdminTemplateId
    : `#canton-streams:${mod}:${ent}`;
  const { offset } = await ledger(config, 'GET', '/v2/state/ledger-end');
  const rows: any[] = await ledger(config, 'POST', '/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: { value: { templateId: filterId, includeCreatedEventBlob: false } },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: offset,
  });
  const matches: any[] = rows
    .map((r) => r.contractEntry?.JsActiveContract?.createdEvent)
    .filter(
      (e: any) =>
        e?.createArgument?.streamId === streamId &&
        e?.createArgument?.sender === party &&
        (recipient === undefined || e?.createArgument?.recipient === recipient),
    )
    .sort(
      (a: any, b: any) =>
        Number(b.createArgument.numIterations ?? 0) - Number(a.createArgument.numIterations ?? 0),
    );
  if (matches.length <= 1) {
    const only = matches[0];
    return only ? { contractId: only.contractId, createArgument: only.createArgument } : undefined;
  }
  // Several admins share id/sender/recipient (e.g. equal numIterations):
  // pick the most-progressed, breaking ties on the lexically-first operator.
  const top = Number(matches[0].createArgument.numIterations ?? 0);
  const first = matches
    .filter((e: any) => Number(e.createArgument.numIterations ?? 0) === top)
    .sort((a: any, b: any) =>
      String(a.createArgument.operator ?? '').localeCompare(String(b.createArgument.operator ?? '')),
    )[0];
  return first ? { contractId: first.contractId, createArgument: first.createArgument } : undefined;
}

async function syncStreamAdmin(
  config: V1LaneConfig,
  agreement: V1Agreement,
  amount: number,
  updateId: string,
): Promise<void> {
  if (!agreement.streamAdminCid) return;
  const cid = (await resolveStreamAdminCid(config, agreement)) ?? agreement.streamAdminCid;
  const operator = config.operatorParty || agreement.payerParty;
  await submit(config, 'sync', [operator], [
    {
      ExerciseCommand: {
        templateId: config.streamAdminTemplateId,
        contractId: cid,
        choice: 'Sync_Iteration',
        choiceArgument: {
          iterationAmount: amount.toFixed(10),
          newAllocationCid: updateId,
          expectedIteration: null,
          settledAt: null,
        },
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// StreamAdmin create (the optional on-ledger RECORD; not a lock)
// ---------------------------------------------------------------------------

export interface StreamAdminCreateInput {
  streamId: string;
  sender: string;
  recipient: string;
  operator: string;
  instrumentAdmin: string;
  instrumentId: string;
  totalDeposited: string;
  startTime: string;
  endTime: string;
  cancellable: boolean;
  observers?: string[];
}

/**
 * Submit a `StreamAdmin` CreateCommand on the JSON Ledger API v2
 * (actAs=[sender]) and return the created contract id. Uses the plain-JSON
 * record encoding the JSON Ledger API v2 / Canton 3.5 expects.
 */
export async function createStreamAdmin(
  config: V1LaneConfig,
  input: StreamAdminCreateInput,
): Promise<{ contractId: string; updateId: string }> {
  const createArgument = {
    streamId: input.streamId,
    sender: input.sender,
    recipient: input.recipient,
    operator: input.operator,
    instrumentId: { admin: input.instrumentAdmin, id: input.instrumentId },
    totalDeposited: Number(input.totalDeposited).toFixed(10),
    // Daml variant → { tag, value }. V1 streams are Linear by default; the
    // StreamAdmin record is observability-only so Linear is a safe shape.
    vestingMode: { tag: 'Linear', value: {} },
    startTime: input.startTime,
    endTime: input.endTime,
    cancellable: input.cancellable,
    totalWithdrawn: '0.0000000000',
    numIterations: '0',
    // Daml enum → bare constructor string.
    status: 'Active',
    currentAllocationCid: null,
    originalAllocationId: null,
    observers: input.observers ?? [],
  };
  const res = await submit(config, 'admin-create', [input.sender], [
    {
      CreateCommand: {
        templateId: config.streamAdminTemplateId,
        createArguments: createArgument,
      },
    },
  ]);
  // The submit-and-wait response carries the created event; resolve the cid
  // from the ACS by streamId to be robust against response-shape drift.
  const ev = await resolveStreamAdminEvent(config, input.sender, input.streamId, input.recipient);
  return {
    contractId: ev?.contractId ?? res.updateId ?? '',
    updateId: res.updateId ?? 'n/a',
  };
}

// ---------------------------------------------------------------------------
// StreamRecord — the operator-signed direct-transfer index (any-node -> any-node)
//
// StreamRecord is `signatory operator`: the operator (this app provider) is the
// only stakeholder, so the payer and payee never need to vet this package and a
// stream can be recorded between any two parties on any nodes. Value moves as
// standard CIP-56 transfers (the money leg); this contract is a best-effort
// on-ledger index the operator maintains alongside them. It holds no funds and
// is never on the settlement path — a create/record failure is observability
// loss, not a payment failure.
// ---------------------------------------------------------------------------

/** cadence -> seconds, for StreamRecord.cadenceSeconds. */
function cadenceToSeconds(cadence: Cadence): number {
  return Math.max(1, Math.round(PERIOD_MS[cadence] / 1000));
}

/** Read the live StreamRecord createEvent for a stream (operator-visible). */
async function resolveStreamRecordEvent(
  config: V1LaneConfig,
  streamId: string,
): Promise<{ contractId: string; createArgument: any } | undefined> {
  const operator = config.operatorParty;
  if (!operator || !operator.includes('::')) return undefined;
  const parts = config.streamRecordTemplateId.split(':');
  const filterId = config.streamRecordTemplateId.startsWith('#')
    ? config.streamRecordTemplateId
    : `#canton-streams:${parts[1]}:${parts[2]}`;
  const { offset } = await ledger(config, 'GET', '/v2/state/ledger-end');
  const rows: any[] = await ledger(config, 'POST', '/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [operator]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: { value: { templateId: filterId, includeCreatedEventBlob: false } },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: offset,
  });
  const matches = rows
    .map((r) => r.contractEntry?.JsActiveContract?.createdEvent)
    .filter((e: any) => e?.createArgument?.streamId === streamId && e?.createArgument?.operator === operator)
    // The most-progressed record is the current one (RecordCycle is consuming).
    .sort(
      (a: any, b: any) =>
        Number(b.createArgument.cyclesSettled ?? 0) - Number(a.createArgument.cyclesSettled ?? 0),
    );
  const only = matches[0];
  return only ? { contractId: only.contractId, createArgument: only.createArgument } : undefined;
}

export interface StreamRecordCreateInput {
  streamId: string;
  operator: string;
  payer: string;
  payee: string;
  instrumentAdmin: string;
  instrumentId: string;
  ratePerCycle: string;
  cadenceSeconds: number;
  startTime: string;
  endTime?: string | null;
  fundingMode: 'MandateFunding' | 'PerCycleFunding' | 'EscrowFunding';
  observers?: string[];
}

/** Create an operator-signed StreamRecord (actAs=[operator]). Returns the cid. */
export async function createStreamRecord(
  config: V1LaneConfig,
  input: StreamRecordCreateInput,
): Promise<{ contractId: string; updateId: string }> {
  const createArgument = {
    streamId: input.streamId,
    operator: input.operator,
    payer: input.payer,
    payee: input.payee,
    instrumentId: { admin: input.instrumentAdmin, id: input.instrumentId },
    ratePerCycle: Number(input.ratePerCycle).toFixed(10),
    cadenceSeconds: String(input.cadenceSeconds),
    startTime: input.startTime,
    endTime: input.endTime ?? null,
    fundingMode: input.fundingMode,
    totalPaid: '0.0000000000',
    cyclesSettled: '0',
    lastTransferId: null,
    status: 'Active',
    observers: input.observers ?? [],
  };
  const res = await submit(config, 'record-create', [input.operator], [
    { CreateCommand: { templateId: config.streamRecordTemplateId, createArguments: createArgument } },
  ]);
  const ev = await resolveStreamRecordEvent(config, input.streamId);
  return { contractId: ev?.contractId ?? res.updateId ?? '', updateId: res.updateId ?? 'n/a' };
}

/**
 * Record one settled cycle on the StreamRecord (RecordCycle, controller
 * operator). Best-effort: returns the new (consuming-recreated) cid, or the
 * old cid unchanged if there is no record / the exercise could not be made.
 */
async function recordStreamCycle(
  config: V1LaneConfig,
  agreement: V1Agreement,
  amount: number,
  transferId: string,
): Promise<string | undefined> {
  if (!agreement.streamRecordCid) return agreement.streamRecordCid;
  const cid = (await resolveStreamRecordEvent(config, agreement.agreementId))?.contractId
    ?? agreement.streamRecordCid;
  await submit(config, 'record-cycle', [config.operatorParty], [
    {
      ExerciseCommand: {
        templateId: config.streamRecordTemplateId,
        contractId: cid,
        choice: 'RecordCycle',
        choiceArgument: { amount: amount.toFixed(10), transferId, settledAt: null },
      },
    },
  ]);
  return (await resolveStreamRecordEvent(config, agreement.agreementId))?.contractId ?? cid;
}

/** Mark a StreamRecord stopped (MarkStopped, controller operator). Best-effort. */
async function markStreamRecordStopped(config: V1LaneConfig, agreement: V1Agreement): Promise<void> {
  if (!agreement.streamRecordCid) return;
  const cid = (await resolveStreamRecordEvent(config, agreement.agreementId))?.contractId
    ?? agreement.streamRecordCid;
  await submit(config, 'record-stop', [config.operatorParty], [
    {
      ExerciseCommand: {
        templateId: config.streamRecordTemplateId,
        contractId: cid,
        choice: 'MarkStopped',
        choiceArgument: {},
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Proxy-owned state store (agreements + settled history)
// ---------------------------------------------------------------------------

function loadStore(config: V1LaneConfig): V1Store {
  if (!existsSync(config.stateFile)) return { agreements: {}, state: {} };
  try {
    const raw = JSON.parse(readFileSync(config.stateFile, 'utf8'));
    return { agreements: raw.agreements ?? {}, state: raw.state ?? {} };
  } catch {
    return { agreements: {}, state: {} };
  }
}

function saveStore(config: V1LaneConfig, store: V1Store): void {
  // Write to a temp file then rename, so a crash mid-write can't truncate the
  // live store (rename is atomic on the same filesystem).
  const tmp = `${config.stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, config.stateFile);
}

/** Lock file guarding the whole V1 store read-modify-write across processes. */
function v1StoreLockFile(config: V1LaneConfig): string {
  return config.stateFile.replace(/\.json$/i, '') + '.lock';
}

function emptyState(): V1StreamState {
  return { settled: 0, cycles: 0, history: [], receiverClaims: [], pendingTransfers: [] };
}

/** An on-chain updateId may back at most one recorded cycle across all streams,
 * so a real transfer to one payee can't be replayed as a cycle on another
 * same-payer stream. Excludes `streamId`, whose own history is checked at the
 * call site, so a same-stream re-record stays idempotent. */
function updateIdRecordedElsewhere(store: V1Store, streamId: string, updateId: string): boolean {
  for (const [id, st] of Object.entries(store.state)) {
    if (id === streamId) continue;
    if (st.history?.some((h) => h.updateId === updateId)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public service API consumed by the proxy routes
// ---------------------------------------------------------------------------

export interface CreateV1StreamInput {
  streamId?: string;
  appId?: string;
  payerParty: string;
  recipientParty: string;
  /** Amount accrued per cadence period (decimal string). Alias: amount. */
  ratePerCycle?: string;
  amount?: string;
  cadence?: Cadence;
  effectiveFrom?: string;
  termEnd?: string;
  arrearsPolicy?: ArrearsPolicy;
  /** Total committed; stamped on the StreamAdmin record. */
  totalDeposited?: string;
  /** Whether to create the optional on-ledger StreamAdmin record. */
  createAdminRecord?: boolean;
  cancellable?: boolean;
  observers?: string[];
  /** Whitelisted asset-registry key this stream pays (e.g. 'usdcx'). Absent ⇒
   *  the proxy's default CC asset. */
  assetKey?: string;
  /** Resolved per-stream settlement instrument; validated against the asset
   *  whitelist by the create route before it reaches here. */
  instrument?: V1Agreement['instrument'];
}

export interface V1StreamView {
  agreement: V1Agreement;
  state: V1StreamState;
  accrued: string;
  due: string;
}

export interface SettleOutcome {
  settled: boolean;
  cycle?: number;
  amount?: string;
  ref?: string;
  updateId?: string;
  adminSynced?: boolean;
  reason?: string;
  /** Set when the cycle's transfer landed as a pending offer (no preapproval)
   * instead of completing — `settled` is false and the recipient must accept. */
  pending?: PendingTransferRecord;
}

export class V1LaneService {
  constructor(private readonly config: V1LaneConfig) {}

  getConfigSummary(): Record<string, unknown> {
    return {
      apiUrl: this.config.apiUrl,
      registryApiUrl: this.config.registryApiUrl,
      ccAdminParty: this.config.ccAdminParty,
      instrumentId: this.config.instrumentId,
      holdingTemplateId: this.config.holdingTemplateId,
      streamAdminTemplateId: this.config.streamAdminTemplateId,
      transferFactoryInterfaceId: this.config.transferFactoryInterfaceId,
      transferInstructionInterfaceId: this.config.transferInstructionInterfaceId,
      allocationFactoryInterfaceId: this.config.allocationFactoryInterfaceId,
      allocationInterfaceId: this.config.allocationInterfaceId,
      allocationTemplateId: this.config.allocationTemplateId,
      receiverClaimTemplateId: this.config.receiverClaimTemplateId,
      operatorParty: this.config.operatorParty,
      executeBeforeSeconds: this.config.executeBeforeSeconds,
      allocateBeforeSeconds: this.config.allocateBeforeSeconds,
      settleBeforeSeconds: this.config.settleBeforeSeconds,
      stateFile: this.config.stateFile,
    };
  }

  private view(agreement: V1Agreement, state: V1StreamState): V1StreamView {
    const nowMs = Date.now();
    let accrued = 0;
    let due = 0;
    try {
      accrued = accruedAmount(agreement, nowMs);
      due = dueAmount(agreement, state.settled, nowMs);
    } catch {
      // invalid cadence — surface zeros rather than throwing on a list call.
    }
    return {
      agreement,
      state,
      accrued: accrued.toFixed(10),
      due: due.toFixed(10),
    };
  }

  /**
   * Stop a V1 stream: halt accrual + settlement. Marks the agreement
   * `status='stopped'` and zeroes the rate so no further cycle is ever due.
   * The agreement + history are preserved; any already-pending offer can still
   * be withdrawn/accepted separately. Only the payer (sender) may stop.
   * Idempotent — stopping an already-stopped stream is a no-op.
   */
  async stopStream(streamId: string): Promise<V1StreamView & { onLedger?: Record<string, unknown> }> {
    // Run under the same per-stream lock as settle so a stop can't interleave a
    // settle mid-flight and let a cycle pull after the intended stop.
    return this.runLocked(streamId, async () => {
      const store = loadStore(this.config);
      const agreement = store.agreements[streamId];
      if (!agreement) {
        throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
      }
      agreement.status = 'stopped';
      agreement.ratePerPeriod = '0';
      saveStore(this.config, store);
      try {
        await markStreamRecordStopped(this.config, agreement);
      } catch {
        // StreamRecord index is best-effort.
      }
      // Scope the returned view to the payer (a stakeholder) — getStream 404s for
      // an undefined caller.
      return this.getStream(streamId, agreement.payerParty);
    });
  }

  /**
   * Stand up a fresh V1 stream:
   *   1. (optional) submit a StreamAdmin CreateCommand actAs=[sender];
   *   2. persist the agreement row the settle path consumes.
   * Money is NOT moved here — funding lives in the payer's own wallet and
   * is drawn per cycle by `settle`.
   */
  async createStream(input: CreateV1StreamInput): Promise<V1StreamView> {
    return this.runLocked('', () => this.createStreamImpl(input));
  }
  private async createStreamImpl(input: CreateV1StreamInput): Promise<V1StreamView> {
    if (!input.payerParty) throw new V1LaneError(400, 'missing_payer', 'payerParty is required');
    if (!input.recipientParty) {
      throw new V1LaneError(400, 'missing_recipient', 'recipientParty is required');
    }
    // A payer streaming to itself has no meaning, and it collapses the delivery
    // check: a refund to the payer is then a holding owned by the recipient too,
    // so the two become indistinguishable. Reject it up front.
    if (input.payerParty === input.recipientParty) {
      throw new V1LaneError(400, 'self_stream', 'payerParty and recipientParty must differ');
    }
    const ratePerPeriod = input.ratePerCycle ?? input.amount;
    if (!ratePerPeriod) {
      throw new V1LaneError(400, 'missing_rate', 'ratePerCycle (or amount) is required');
    }
    const cadence = input.cadence ?? 'daily';
    if (!PERIOD_MS[cadence]) {
      throw new V1LaneError(
        400,
        'invalid_cadence',
        `cadence must be second|minute|hourly|daily, got "${cadence}"`,
      );
    }
    const streamId = input.streamId ?? `v1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const store = loadStore(this.config);
    if (store.agreements[streamId]) {
      throw new V1LaneError(409, 'stream_exists', `V1 stream "${streamId}" already exists`);
    }

    const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();
    const totalDeposited = input.totalDeposited ?? ratePerPeriod;

    let streamAdminCid: string | undefined;
    if (input.createAdminRecord) {
      const operator = this.config.operatorParty || input.payerParty;
      const created = await createStreamAdmin(this.config, {
        streamId,
        sender: input.payerParty,
        recipient: input.recipientParty,
        operator,
        instrumentAdmin: this.config.ccAdminParty,
        instrumentId: this.config.instrumentId,
        totalDeposited,
        startTime: effectiveFrom,
        endTime: input.termEnd ?? new Date(Date.parse(effectiveFrom) + PERIOD_MS[cadence] * 365).toISOString(),
        cancellable: input.cancellable ?? true,
        observers: input.observers,
      });
      streamAdminCid = created.contractId;
    }

    // Operator-signed StreamRecord — the on-ledger index for the direct-transfer
    // model. Created when a real operator party is configured; best-effort so a
    // create failure never blocks the stream (the money leg is independent).
    let streamRecordCid: string | undefined;
    if (this.config.operatorParty && this.config.operatorParty.includes('::')) {
      try {
        const rec = await createStreamRecord(this.config, {
          streamId,
          operator: this.config.operatorParty,
          payer: input.payerParty,
          payee: input.recipientParty,
          instrumentAdmin: this.config.ccAdminParty,
          instrumentId: this.config.instrumentId,
          ratePerCycle: ratePerPeriod,
          cadenceSeconds: cadenceToSeconds(cadence),
          startTime: effectiveFrom,
          endTime: input.termEnd ?? null,
          fundingMode: 'PerCycleFunding',
          observers: input.observers,
        });
        streamRecordCid = rec.contractId;
      } catch {
        // Index is best-effort; the stream proceeds without it.
      }
    }

    const agreement: V1Agreement = {
      agreementId: streamId,
      ...(input.appId ? { appId: input.appId } : {}),
      payerParty: input.payerParty,
      recipientParty: input.recipientParty,
      ratePerPeriod,
      cadence,
      effectiveFrom,
      ...(input.termEnd ? { termEnd: input.termEnd } : {}),
      arrearsPolicy: input.arrearsPolicy ?? 'catch-up',
      ...(streamAdminCid ? { streamAdminCid } : {}),
      ...(streamRecordCid ? { streamRecordCid } : {}),
      totalDeposited,
      createdAt: new Date().toISOString(),
      ...(input.assetKey ? { assetKey: input.assetKey } : {}),
      ...(input.instrument ? { instrument: input.instrument } : {}),
    };

    store.agreements[streamId] = agreement;
    store.state[streamId] = emptyState();
    saveStore(this.config, store);

    return this.view(agreement, store.state[streamId]!);
  }

  /** List V1 streams from the proxy state store, enriched with on-ledger
   * StreamAdmin progress where a record exists. Scoped to `callerParty`: only
   * streams where the caller is the payer or recipient are returned, so one
   * wallet can never enumerate another party's streams. */
  async listStreams(callerParty?: string): Promise<V1StreamView[]> {
    const store = loadStore(this.config);
    return Object.values(store.agreements)
      .filter((a) => this.isStakeholder(a, callerParty))
      .map((a) => this.view(a, store.state[a.agreementId] ?? emptyState()));
  }

  /** Ledger-backed incoming view for a recipient: pending offers awaiting their
   * accept + CC already delivered, read straight from the participant. Unlike
   * `listStreams` (proxy JSON store, proxy-created streams only), this surfaces
   * EVERY transfer to the party — including raw-registry and wallet-sent ones
   * the proxy never tracked. */
  async listReceived(callerParty?: string): Promise<ReceivedView> {
    if (!callerParty) {
      throw new V1LaneError(401, 'unauthenticated', 'a caller party is required');
    }
    const [pending, received] = await Promise.all([
      incomingOffers(this.config, callerParty),
      receivedDeliveries(this.config, callerParty),
    ]);
    return { party: callerParty, pending, received };
  }

  /** Accept a pending incoming offer by contract id (recipient-scoped,
   * store-independent). The proxy submits TransferInstruction_Accept as the
   * caller — for a hosted/dev-mode recipient (e.g. a validator-local party with
   * no browser wallet). `incomingOffers` only returns offers where the caller
   * is the receiver, so a caller can never accept another party's offer. */
  async acceptReceived(
    callerParty: string | undefined,
    transferInstructionCid: string,
  ): Promise<{ updateId: string; amount: string; sender: string }> {
    if (!callerParty) {
      throw new V1LaneError(401, 'unauthenticated', 'a caller party is required');
    }
    if (!transferInstructionCid) {
      throw new V1LaneError(400, 'missing_cid', 'transferInstructionCid is required');
    }
    return acceptOfferByCid(this.config, callerParty, transferInstructionCid);
  }

  /** Model 2 (wallet party, e.g. a Loop party NOT hosted on this participant):
   * build the TransferInstruction_Accept command + choice-context disclosures so
   * the caller's WALLET can sign+submit it on its own participant. The registry
   * choice-context needs the validator's whitelisted egress, so it must be built
   * here even though the proxy can't submit for a party it doesn't host. */
  async prepareAcceptReceived(
    callerParty: string | undefined,
    transferInstructionCid: string,
  ): Promise<{ command: unknown; disclosedContracts: unknown[]; actAs: string }> {
    if (!callerParty) {
      throw new V1LaneError(401, 'unauthenticated', 'a caller party is required');
    }
    if (!transferInstructionCid) {
      throw new V1LaneError(400, 'missing_cid', 'transferInstructionCid is required');
    }
    // A Loop-hosted recipient is NOT visible in this participant's ACS, so we
    // cannot look the offer up here — we just build the accept command from the
    // cid via the (whitelisted-egress) registry choice-context. The wallet
    // submits it; the ledger enforces that `callerParty` is the offer's receiver
    // and that the deadline has not passed.
    const record: PendingTransferRecord = {
      cycle: 0,
      amount: '0',
      ref: `received:${transferInstructionCid.slice(0, 12)}`,
      transferInstructionCid,
      executeBefore: new Date(Date.now() + this.config.executeBeforeSeconds * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    const prepared = await prepareInstructionActionCommand(this.config, record, 'accept', callerParty);
    return { command: prepared.command, disclosedContracts: prepared.disclosedContracts, actAs: callerParty };
  }

  /** True when `callerParty` is a read-stakeholder (payer or recipient) of the
   * agreement. A missing caller is treated as unauthorized (fail closed). */
  private isStakeholder(agreement: V1Agreement, callerParty?: string): boolean {
    return (
      !!callerParty &&
      (agreement.payerParty === callerParty || agreement.recipientParty === callerParty)
    );
  }

  /** Detail for one V1 stream, including settled cycles and (best-effort)
   * the live on-ledger StreamAdmin record. Scoped to `callerParty`: only the
   * payer or recipient may read a stream. */
  async getStream(
    streamId: string,
    callerParty?: string,
  ): Promise<V1StreamView & { onLedger?: Record<string, unknown> }> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    // Return an identical 404 whether the stream is absent OR the caller is not
    // a stakeholder (payer/recipient), so a non-stakeholder cannot probe which
    // V1 stream ids exist by distinguishing 403 (exists) from 404 (absent).
    if (!agreement || !this.isStakeholder(agreement, callerParty)) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const view = this.view(agreement, store.state[streamId] ?? emptyState());
    let onLedger: Record<string, unknown> | undefined;
    try {
      const ev = await resolveStreamAdminEvent(
        this.config,
        agreement.payerParty,
        streamId,
        agreement.recipientParty,
      );
      if (ev) {
        onLedger = {
          contractId: ev.contractId,
          totalWithdrawn: ev.createArgument.totalWithdrawn,
          numIterations: ev.createArgument.numIterations,
          status: ev.createArgument.status,
          currentAllocationCid: ev.createArgument.currentAllocationCid,
        };
      }
    } catch {
      // ledger unreachable / no record — return state-only view.
    }
    return onLedger ? { ...view, onLedger } : view;
  }

  /**
   * Settle ONE cycle now (the proxy's on-demand path), serialized per stream.
   * Two concurrent settles for the same stream must never both pay: we chain
   * each settle after any in-flight settle for the same streamId so the
   * read-state → submit-transfer → write-state sequence runs atomically within
   * this process. (A multi-process deployment would additionally need a shared
   * lock; this proxy owns the V1 state file as a single writer.)
   */
  async settle(
    streamId: string,
    opts: { force?: boolean; amount?: string } = {},
  ): Promise<SettleOutcome> {
    return this.runLocked(streamId, () => this.settleOnce(streamId, opts));
  }

  /** Serialize a mutation for one stream after any in-flight settle/stop, so the
   * read → submit → write sequence runs atomically within this process. A
   * multi-process deployment would still need a shared lock; this proxy owns the
   * V1 state file as a single writer. */
  // The store is a single whole-file load->mutate->save with awaits (transfers,
  // ~20s Scan polls) in between, so mutations on DIFFERENT streams must not
  // interleave either: two would snapshot the same file and last-writer-wins
  // would clobber the other's settled total / status / history — re-opening a
  // paid cycle or reverting a stop. Serialize every mutating path globally in
  // this process, and take a cross-process file lock so a second instance (or a
  // redeploy overlap) can't race the same file.
  private storeMutationLock: Promise<unknown> = Promise.resolve();
  private runLocked<T>(_streamId: string, fn: () => Promise<T>): Promise<T> {
    const run = this.storeMutationLock.then(
      () => this.withStoreLock(fn),
      () => this.withStoreLock(fn),
    );
    this.storeMutationLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = v1StoreLockFile(this.config);
    // Longer than any single mutation, which may hold the lock across a ~20s
    // Scan verification; a dead holder is reclaimed immediately by pid.
    const staleMs = 120000;
    const token = await acquireStoreLock(lockPath, staleMs);
    try {
      return await fn();
    } finally {
      releaseStoreLock(lockPath, token);
    }
  }

  /**
   * The actual settlement. Mirrors the scheduler's tick() ordering exactly:
   *   compute due → settleCycle → record settled total BEFORE syncStreamAdmin.
   * A Sync_Iteration failure is reported but never re-fires the payment.
   * MUST run under the per-stream lock in `settle()` — never call directly.
   */
  private async settleOnce(
    streamId: string,
    opts: { force?: boolean; amount?: string } = {},
  ): Promise<SettleOutcome> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    // A stopped stream must never settle again — not even via `force` or an
    // explicit `amount`, which otherwise bypass the accrual/status gate.
    if (agreement.status === 'stopped') {
      return { settled: false, reason: 'stopped' };
    }
    const st = store.state[streamId] ?? emptyState();
    store.state[streamId] = st;

    const nowMs = Date.now();
    let due: number;
    if (opts.amount !== undefined) {
      const requested = Number(opts.amount);
      if (!(requested > 0)) throw new V1LaneError(400, 'invalid_amount', 'amount must be > 0');
      // An explicit amount may top a cycle up to — but never beyond — what has
      // accrued. `force` still permits one period when nothing has accrued yet.
      const accruedDue = dueAmount(agreement, st.settled, nowMs);
      const cap = Math.max(accruedDue, opts.force ? Number(agreement.ratePerPeriod) : 0);
      due = Math.min(requested, cap);
    } else {
      due = dueAmount(agreement, st.settled, nowMs);
      // On-demand demo: if nothing has accrued yet but the caller wants to
      // see a settlement, force exactly one period.
      if (due <= 0 && opts.force) due = Number(agreement.ratePerPeriod);
    }
    if (due <= 0) {
      return { settled: false, reason: 'nothing_due' };
    }

    const result = await settleCycle(this.config, agreement, due, st.cycles + 1);

    // Classify the on-chain outcome before crediting the cycle (mirrors
    // recordSettle): a created TransferInstruction means the receiver had no
    // pre-approval, so the transfer is a PENDING OFFER (funds locked, NOT
    // delivered). Track it for the receiver to accept and do NOT advance
    // settled/cycles or report "settled" — otherwise the stream over-reports an
    // undelivered cycle as paid.
    if (result.pendingInstructionCid) {
      const cycleNo = st.cycles + 1;
      const rows = pendingRecords(st);
      let record = rows.find((r) => r.transferInstructionCid === result.pendingInstructionCid);
      if (!record) {
        record = {
          cycle: cycleNo,
          amount: due.toFixed(10),
          ref: result.ref,
          transferInstructionCid: result.pendingInstructionCid,
          createUpdateId: result.updateId,
          executeBefore: new Date(
            Date.now() + this.config.executeBeforeSeconds * 1000,
          ).toISOString(),
          createdAt: new Date().toISOString(),
          status: 'pending',
        };
        rows.push(record);
        saveStore(this.config, store);
      }
      return {
        settled: false,
        reason: 'pending_acceptance',
        cycle: st.cycles,
        amount: due.toFixed(10),
        ref: result.ref,
        pending: record,
      };
    }

    // CRITICAL: record the payment BEFORE any secondary step. A failure after
    // the transfer committed must never lead to a re-payment.
    st.settled = Number((st.settled + due).toFixed(10));
    st.cycles += 1;
    st.history.push({
      at: new Date().toISOString(),
      amount: due.toFixed(10),
      ref: result.ref,
      updateId: result.updateId,
    });
    if (st.history.length > 500) st.history.splice(0, st.history.length - 500);
    saveStore(this.config, store);

    // On-ledger record is best-effort; a failure here is observability loss.
    let adminSynced = false;
    let reason: string | undefined;
    try {
      await syncStreamAdmin(this.config, agreement, due, result.updateId);
      adminSynced = Boolean(agreement.streamAdminCid);
    } catch (e) {
      reason = `sync_failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
    }
    try {
      const newCid = await recordStreamCycle(this.config, agreement, due, result.updateId);
      if (newCid && newCid !== agreement.streamRecordCid) {
        agreement.streamRecordCid = newCid;
        saveStore(this.config, store);
      }
    } catch {
      // StreamRecord index is best-effort; a miss is observability loss only.
    }

    return {
      settled: true,
      cycle: st.cycles,
      amount: due.toFixed(10),
      ref: result.ref,
      updateId: result.updateId,
      adminSynced,
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * Model 2 — phase 1: form (but do NOT submit) the next cycle's transfer so a
   * wallet-held payer can submit it through ITS OWN participant via CIP-103.
   * `holdings` are the payer's spendable Amulet holdings (cid + amount), passed
   * by the caller because a wallet-held party's holdings live on its own
   * participant, not this one. Returns the ready-to-submit command + disclosed
   * contracts + the cycle number to echo back to `recordSettle` after the
   * wallet commits. Does NOT touch state — nothing is settled until recorded.
   */
  async prepareSettle(
    streamId: string,
    opts: { force?: boolean; amount?: string; holdings?: HoldingInput[] } = {},
  ): Promise<({ prepared: true } & PreparedSettle) | { prepared: false; reason: string }> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    const nowMs = Date.now();
    let due: number;
    if (opts.amount !== undefined) {
      due = Number(opts.amount);
      if (!(due > 0)) throw new V1LaneError(400, 'invalid_amount', 'amount must be > 0');
    } else {
      due = dueAmount(agreement, st.settled, nowMs);
      if (due <= 0 && opts.force) due = Number(agreement.ratePerPeriod);
    }
    if (due <= 0) return { prepared: false, reason: 'nothing_due' };
    const prepareFn =
      resolveInstrument(this.config, agreement).transferVersion === 'v2'
        ? prepareSettleCommandV2
        : prepareSettleCommand;
    const prepared = await prepareFn(this.config, agreement, due, st.cycles + 1, opts.holdings);
    return { prepared: true, ...prepared };
  }

  /**
   * Receiver-claim phase 1: form a V1 AllocationFactory_Allocate for Alice's
   * wallet to sign. No proxy state is mutated until the caller records the
   * committed allocation cid.
   */
  async prepareReceiverAllocation(
    streamId: string,
    opts: {
      force?: boolean;
      amount?: string;
      holdings?: HoldingInput[];
      executor?: string;
      unlockAt?: string;
      expiresAt?: string;
    } = {},
  ): Promise<({ prepared: true } & PreparedAllocation) | { prepared: false; reason: string }> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    const cycleNo = nextClaimCycle(st);
    const nowMs = Date.now();
    let due: number;
    if (opts.amount !== undefined) {
      due = Number(opts.amount);
      if (!(due > 0)) throw new V1LaneError(400, 'invalid_amount', 'amount must be > 0');
    } else {
      due = dueAmount(agreement, st.settled, nowMs);
      if (due <= 0 && opts.force) due = Number(agreement.ratePerPeriod);
    }
    if (due <= 0) return { prepared: false, reason: 'nothing_due' };
    const prepared = await prepareReceiverAllocationCommand(this.config, agreement, {
      amount: due,
      cycleNo,
      holdings: opts.holdings,
      executor: opts.executor,
      unlockAt: opts.unlockAt ?? (opts.force ? new Date().toISOString() : undefined),
      expiresAt: opts.expiresAt,
    });
    return { prepared: true, ...prepared };
  }

  /**
   * Receiver-claim phase 2: record the allocation cid Alice's wallet created.
   * This is intentionally separate because wallet APIs do not consistently
   * return created contract ids in submit responses.
   */
  async recordReceiverAllocation(
    streamId: string,
    input: {
      allocationCid: string;
      amount: string;
      ref?: string;
      cycle: number;
      executor?: string;
      allocationUpdateId?: string;
      unlockAt: string;
      expiresAt: string;
    },
  ): Promise<ReceiverClaimRecord> {
    return this.runLocked(streamId, () => this.recordReceiverAllocationImpl(streamId, input));
  }
  private async recordReceiverAllocationImpl(
    streamId: string,
    input: {
      allocationCid: string;
      amount: string;
      ref?: string;
      cycle: number;
      executor?: string;
      allocationUpdateId?: string;
      unlockAt: string;
      expiresAt: string;
    },
  ): Promise<ReceiverClaimRecord> {
    if (!input.allocationCid) {
      throw new V1LaneError(400, 'missing_allocation_cid', 'allocationCid is required');
    }
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    store.state[streamId] = st;
    const amount = Number(input.amount);
    if (!(amount > 0)) throw new V1LaneError(400, 'invalid_amount', 'amount must be > 0');
    const cycle = Number(input.cycle);
    if (!Number.isInteger(cycle) || cycle <= 0) {
      throw new V1LaneError(400, 'invalid_cycle', 'cycle must be a positive integer');
    }
    const records = claimRecords(st);
    const existing =
      records.find((r) => r.allocationCid === input.allocationCid) ??
      records.find((r) => r.cycle === cycle);
    const record: ReceiverClaimRecord =
      existing ??
      {
        cycle,
        amount: amount.toFixed(10),
        ref: input.ref ?? `${streamId}:cycle-${cycle}`,
        executor: input.executor ?? agreement.recipientParty,
        allocationCid: input.allocationCid,
        unlockAt: assertIsoTime(input.unlockAt, 'unlockAt'),
        expiresAt: assertIsoTime(input.expiresAt, 'expiresAt'),
        createdAt: new Date().toISOString(),
        status: 'allocated',
      };
    record.amount = amount.toFixed(10);
    record.ref = input.ref ?? record.ref;
    record.executor = input.executor ?? record.executor;
    record.allocationCid = input.allocationCid;
    record.unlockAt = assertIsoTime(input.unlockAt, 'unlockAt');
    record.expiresAt = assertIsoTime(input.expiresAt, 'expiresAt');
    record.allocationUpdateId = input.allocationUpdateId ?? record.allocationUpdateId;
    if (!existing) records.push(record);
    saveStore(this.config, store);
    return record;
  }

  /**
   * Receiver-claim phase 3: build the ReceiverClaimV1 create command for
   * Alice's wallet. This captures Alice's consent once; Bob claims later.
   */
  async prepareReceiverClaim(
    streamId: string,
    selector: { cycle?: number; allocationCid?: string } = {},
  ): Promise<PreparedReceiverClaim> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    const record = selectClaimRecord(st, selector);
    if (!record) {
      throw new V1LaneError(404, 'allocation_not_recorded', 'No recorded allocation found for this stream');
    }
    if (record.status === 'claimed' || record.status === 'withdrawn') {
      throw new V1LaneError(409, 'claim_not_open', `Claim is already ${record.status}`);
    }
    return prepareReceiverClaimCreateCommand(this.config, agreement, record);
  }

  /**
   * Receiver-claim phase 4: record the ReceiverClaimV1 cid created by Alice.
   * Bob's inbox/claim button is driven from this recorded cid.
   */
  async recordReceiverClaim(
    streamId: string,
    input: { receiverClaimCid: string; cycle?: number; allocationCid?: string },
  ): Promise<ReceiverClaimRecord> {
    return this.runLocked(streamId, () => this.recordReceiverClaimImpl(streamId, input));
  }
  private async recordReceiverClaimImpl(
    streamId: string,
    input: { receiverClaimCid: string; cycle?: number; allocationCid?: string },
  ): Promise<ReceiverClaimRecord> {
    if (!input.receiverClaimCid) {
      throw new V1LaneError(400, 'missing_receiver_claim_cid', 'receiverClaimCid is required');
    }
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    store.state[streamId] = st;
    const record = selectClaimRecord(st, input);
    if (!record) {
      throw new V1LaneError(404, 'allocation_not_recorded', 'No recorded allocation found for this stream');
    }
    if (record.status === 'claimed' || record.status === 'withdrawn') {
      throw new V1LaneError(409, 'claim_not_open', `Claim is already ${record.status}`);
    }
    record.receiverClaimCid = input.receiverClaimCid;
    record.status = 'claim_ready';
    saveStore(this.config, store);
    return record;
  }

  /**
   * Receiver-claim phase 5: build Bob's Claim exercise. This fetches the live
   * registry execute-transfer choice-context and disclosed contracts, which is
   * the missing piece that the Daml unit test's emptyExtraArgs cannot cover.
   */
  async prepareClaim(
    streamId: string,
    selector: { cycle?: number; receiverClaimCid?: string; allocationCid?: string } = {},
  ): Promise<({ prepared: true } & PreparedClaim) | { prepared: false; reason: string }> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    const record = selectClaimRecord(st, selector);
    if (!record) return { prepared: false, reason: 'no_claim_ready' };
    if (record.status === 'claimed') return { prepared: false, reason: 'already_claimed' };
    if (record.status === 'withdrawn') return { prepared: false, reason: 'withdrawn' };
    if (!record.receiverClaimCid || record.status !== 'claim_ready') {
      return { prepared: false, reason: 'claim_contract_missing' };
    }
    if (record.executor !== agreement.recipientParty) {
      throw new V1LaneError(
        409,
        'operator_cosign_required',
        'This claim uses an executor distinct from the recipient; solo receiver claim requires executor == recipient.',
      );
    }
    if (Date.now() < Date.parse(record.unlockAt)) {
      return { prepared: false, reason: 'not_unlocked' };
    }
    const prepared = await prepareReceiverClaimExerciseCommand(this.config, record);
    return { prepared: true, ...prepared };
  }

  /** Receiver-claim phase 6: record Bob's wallet-submitted claim once Scan
   * confirms the transfer committed on-chain. */
  async recordClaim(
    streamId: string,
    input: { updateId: string; cycle?: number; receiverClaimCid?: string; allocationCid?: string },
  ): Promise<SettleOutcome> {
    return this.runLocked(streamId, () => this.recordClaimImpl(streamId, input));
  }
  private async recordClaimImpl(
    streamId: string,
    input: { updateId: string; cycle?: number; receiverClaimCid?: string; allocationCid?: string },
  ): Promise<SettleOutcome> {
    if (!input.updateId) {
      throw new V1LaneError(400, 'missing_update_id', 'updateId is required');
    }
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    store.state[streamId] = st;
    const record = selectClaimRecord(st, input);
    if (!record) {
      throw new V1LaneError(404, 'claim_not_found', 'No receiver claim found for this stream');
    }
    if (record.claimUpdateId === input.updateId || st.history.some((h) => h.updateId === input.updateId)) {
      return { settled: false, reason: 'already_recorded', cycle: st.cycles };
    }
    // The allocation's own creation update carries its transfer authorization and
    // its created contract id, so it must never be claimed as the delivery.
    if (record.allocationUpdateId && input.updateId === record.allocationUpdateId) {
      throw new V1LaneError(
        422,
        'settlement_mismatch',
        `update ${input.updateId} is the allocation's creation, not its execution; refusing to record.`,
      );
    }
    // Reject a cross-stream replay of the same on-chain update.
    if (input.updateId && updateIdRecordedElsewhere(store, streamId, input.updateId)) {
      throw new V1LaneError(409, 'update_replayed', `update ${input.updateId} is already recorded on another stream`);
    }
    if (record.status === 'claimed') {
      return { settled: false, reason: 'already_claimed', cycle: st.cycles };
    }

    // Bind to the exact allocation being claimed and require the committed update
    // deliver at least the tracked amount to the recipient; credit the on-chain
    // amount, never the stored figure off an unrelated transfer.
    const { amount: verifiedAmount } = await verifyConsummationOnScan(configForStream(this.config, agreement), input.updateId, {
      trackedCid: record.allocationCid || record.receiverClaimCid || input.allocationCid,
      recipient: agreement.recipientParty,
      minAmount: Number(record.amount),
    });
    const amount = Math.min(Number(record.amount), verifiedAmount);
    st.settled = Number((st.settled + amount).toFixed(10));
    st.cycles = Math.max(st.cycles, record.cycle);
    st.history.push({
      at: new Date().toISOString(),
      amount: amount.toFixed(10),
      ref: record.ref,
      updateId: input.updateId,
    });
    if (st.history.length > 500) st.history.splice(0, st.history.length - 500);
    record.status = 'claimed';
    record.claimUpdateId = input.updateId;
    saveStore(this.config, store);

    let adminSynced = false;
    let reason: string | undefined;
    try {
      await syncStreamAdmin(this.config, agreement, amount, input.updateId);
      adminSynced = Boolean(agreement.streamAdminCid);
    } catch (e) {
      reason = `sync_failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
    }

    return {
      settled: true,
      cycle: st.cycles,
      amount: amount.toFixed(10),
      ref: record.ref,
      updateId: input.updateId,
      adminSynced,
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * Model 2 — phase 2: record a cycle the payer's wallet already committed
   * on-ledger. Idempotent on `updateId`, so a retried record never double-counts
   * a transfer that already settled. Advances the optional StreamAdmin record
   * best-effort, exactly like `settle()`.
   */
  async recordSettle(
    streamId: string,
    input: { updateId: string; amount: string; ref?: string; executeBefore?: string; transferProof?: TransferProof },
  ): Promise<SettleOutcome> {
    return this.runLocked(streamId, () => this.recordSettleImpl(streamId, input));
  }
  private async recordSettleImpl(
    streamId: string,
    input: { updateId: string; amount: string; ref?: string; executeBefore?: string; transferProof?: TransferProof },
  ): Promise<SettleOutcome> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    store.state[streamId] = st;
    if (!(Number(input.amount) > 0)) throw new V1LaneError(400, 'invalid_amount', 'amount must be > 0');
    // Idempotent: never double-count the same committed transfer.
    if (input.updateId && st.history.some((h) => h.updateId === input.updateId)) {
      return { settled: false, reason: 'already_recorded', cycle: st.cycles };
    }
    // And never let one real transfer be replayed as a cycle on a different
    // stream (the check above only covers this stream).
    if (input.updateId && updateIdRecordedElsewhere(store, streamId, input.updateId)) {
      throw new V1LaneError(409, 'update_replayed', `update ${input.updateId} is already recorded on another stream`);
    }
    // Non-CC direct-delivery (e.g. USDCx): the proxy can't witness the transfer
    // (both parties remote, asset not on CC's Scan), so verification is wallet-
    // side. When the wallet supplies a transfer proof, validate it structurally
    // against this agreement and credit the proven amount; when absent, fall back
    // to the interim trust path (record on updateId + input.amount). The
    // idempotency and cross-stream replay guards above hold either way, and this
    // lane is non-custodial. CC keeps the Scan proof below.
    const settleInst = resolveInstrument(this.config, agreement);
    if (settleInst.id !== this.config.instrumentId) {
      const proof = input.transferProof;
      if (proof && typeof proof === 'object') {
        // Fail closed on any mismatch — the proof must describe THIS stream's
        // payer→recipient delivery of THIS instrument for at least the due amount.
        if (proof.receiver !== agreement.recipientParty) {
          throw new V1LaneError(422, 'settlement_proof_mismatch',
            `transfer proof receiver does not match the stream recipient; refusing to record.`);
        }
        if (proof.sender && proof.sender !== agreement.payerParty) {
          throw new V1LaneError(422, 'settlement_proof_mismatch',
            `transfer proof sender does not match the stream payer; refusing to record.`);
        }
        if (proof.instrumentId !== settleInst.id) {
          throw new V1LaneError(422, 'settlement_proof_mismatch',
            `transfer proof instrument ${proof.instrumentId} does not match the stream instrument ${settleInst.id}; refusing to record.`);
        }
        const proofAmount = Number(proof.amount);
        const dueAmt = Number(input.amount);
        if (!Number.isFinite(proofAmount) || proofAmount + 1e-9 < dueAmt) {
          throw new V1LaneError(422, 'settlement_proof_mismatch',
            `transfer proof amount ${proof.amount} is less than the cycle amount ${input.amount}; refusing to record.`);
        }
        const credited = Number(proofAmount.toFixed(10));
        st.settled = Number((st.settled + credited).toFixed(10));
        st.cycles += 1;
        const ref = input.ref ?? `${streamId}:cycle-${st.cycles}`;
        st.history.push({
          at: new Date().toISOString(),
          amount: credited.toFixed(10),
          ref,
          updateId: input.updateId,
          ...(proof.delivered ? { verified: true } : {}),
        });
        if (st.history.length > 500) st.history.splice(0, st.history.length - 500);
        saveStore(this.config, store);
        console.log(
          `v1_settle_recorded_wallet_proof stream=${streamId} asset=${agreement.assetKey ?? settleInst.id} ` +
            `amount=${credited.toFixed(4)} updateId=${input.updateId} delivered=${proof.delivered}`,
        );
        return { settled: true, cycle: st.cycles, amount: credited.toFixed(10), ref, updateId: input.updateId };
      }
      const credited = Number(input.amount);
      st.settled = Number((st.settled + credited).toFixed(10));
      st.cycles += 1;
      const ref = input.ref ?? `${streamId}:cycle-${st.cycles}`;
      st.history.push({ at: new Date().toISOString(), amount: credited.toFixed(10), ref, updateId: input.updateId });
      if (st.history.length > 500) st.history.splice(0, st.history.length - 500);
      saveStore(this.config, store);
      console.log(
        `v1_settle_recorded_unverified stream=${streamId} asset=${agreement.assetKey ?? settleInst.id} ` +
          `amount=${credited.toFixed(4)} updateId=${input.updateId} reason=no_scan_vantage_for_non_cc`,
      );
      return { settled: true, cycle: st.cycles, amount: credited.toFixed(10), ref, updateId: input.updateId };
    }
    // The updateId is a client claim — verify the transfer committed on chain,
    // moved payer -> recipient in CC, and carries this stream's agreement tag
    // (so an unrelated transfer between the same parties can't be recorded as a
    // cycle). Credit the on-chain amount it returns, never the client's amount.
    const { body: updateBody, amount } = await verifyDeliveryOnScan(configForStream(this.config, agreement), input.updateId, {
      sender: agreement.payerParty,
      receiver: agreement.recipientParty,
      minAmount: 0,
      agreementRef: streamId,
    });

    // Classify the on-chain outcome from the committed transaction:
    //  - a created TransferInstruction → the receiver had NO pre-approval, so
    //    this is a PENDING OFFER (funds locked, NOT delivered). Track it for the
    //    receiver to accept; do NOT advance settled/cycles or claim "settled".
    //  - none → the transfer completed directly (the receiver was pre-approved).
    const instructionCid = findCreatedInstructionCid(updateBody);
    if (instructionCid) {
      const cycleNo = st.cycles + 1;
      const pendingRef = input.ref ?? `${streamId}:cycle-${cycleNo}`;
      const rows = pendingRecords(st);
      let record = rows.find((r) => r.transferInstructionCid === instructionCid);
      if (!record) {
        record = {
          cycle: cycleNo,
          amount: amount.toFixed(10),
          ref: pendingRef,
          transferInstructionCid: instructionCid,
          createUpdateId: input.updateId,
          executeBefore:
            input.executeBefore && Number.isFinite(Date.parse(input.executeBefore))
              ? new Date(Date.parse(input.executeBefore)).toISOString()
              : new Date(Date.now() + this.config.executeBeforeSeconds * 1000).toISOString(),
          createdAt: new Date().toISOString(),
          status: 'pending',
        };
        rows.push(record);
        saveStore(this.config, store);
      }
      return {
        settled: false,
        reason: 'pending_acceptance',
        cycle: st.cycles,
        amount: amount.toFixed(10),
        ref: pendingRef,
        pending: record,
      };
    }

    st.settled = Number((st.settled + amount).toFixed(10));
    st.cycles += 1;
    const ref = input.ref ?? `${streamId}:cycle-${st.cycles}`;
    st.history.push({
      at: new Date().toISOString(),
      amount: amount.toFixed(10),
      ref,
      updateId: input.updateId,
    });
    if (st.history.length > 500) st.history.splice(0, st.history.length - 500);
    saveStore(this.config, store);

    let adminSynced = false;
    let reason: string | undefined;
    try {
      await syncStreamAdmin(this.config, agreement, amount, input.updateId);
      adminSynced = Boolean(agreement.streamAdminCid);
    } catch (e) {
      reason = `sync_failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
    }
    try {
      const newCid = await recordStreamCycle(this.config, agreement, amount, input.updateId);
      if (newCid && newCid !== agreement.streamRecordCid) {
        agreement.streamRecordCid = newCid;
        saveStore(this.config, store);
      }
    } catch {
      // StreamRecord index is best-effort; a miss is observability loss only.
    }
    return {
      settled: true,
      cycle: st.cycles,
      amount: amount.toFixed(10),
      ref,
      updateId: input.updateId,
      adminSynced,
      ...(reason ? { reason } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Pending-offer lane — TransferInstruction Accept / Withdraw
  //
  // When a cycle's TransferFactory_Transfer lands as a pending instruction
  // (the receiver has NO pre-approval), the registry returns a
  // `TransferInstruction` instead of completing. Bob accepts it from his wallet;
  // Alice can withdraw/retry after expiry. Every step is Scan-verified before
  // any state mutates, and `settled`/`cycles` advance ONLY on accept (money has
  // not moved while an offer is merely pending).
  // -------------------------------------------------------------------------

  /**
   * Recover pending offers that committed on-ledger but weren't recorded — e.g.
   * the payer's wallet threw a (false) rejection AFTER the transfer committed
   * (a known Loop quirk). Discovers active AmuletTransferInstructions this
   * participant witnesses for the stream's payer→recipient and records any not
   * already tracked. Truthful: only records contracts genuinely active on
   * ledger, so it never invents an offer. Idempotent.
   */
  async recoverPendingOffers(streamId: string): Promise<{ recovered: PendingTransferRecord[] }> {
    return this.runLocked(streamId, () => this.recoverPendingOffersImpl(streamId));
  }
  private async recoverPendingOffersImpl(streamId: string): Promise<{ recovered: PendingTransferRecord[] }> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    store.state[streamId] = st;
    const rows = pendingRecords(st);
    const known = new Set(rows.map((r) => r.transferInstructionCid));
    const onLedger = await activeTransferInstructions(
      this.config,
      agreement.recipientParty,
      agreement.payerParty,
    );
    const recovered: PendingTransferRecord[] = [];
    for (const inst of onLedger) {
      if (known.has(inst.cid)) continue;
      const cycleNo = st.cycles + rows.length + recovered.length + 1;
      const rec: PendingTransferRecord = {
        cycle: cycleNo,
        amount: Number(inst.amount).toFixed(10),
        ref: inst.ref ?? `${streamId}:cycle-${cycleNo}`,
        transferInstructionCid: inst.cid,
        executeBefore:
          inst.executeBefore && Number.isFinite(Date.parse(inst.executeBefore))
            ? new Date(Date.parse(inst.executeBefore)).toISOString()
            : new Date(Date.now() + this.config.executeBeforeSeconds * 1000).toISOString(),
        createdAt: new Date().toISOString(),
        status: 'pending',
      };
      rows.push(rec);
      recovered.push(rec);
      known.add(inst.cid);
    }
    if (recovered.length) saveStore(this.config, store);
    return { recovered };
  }

  /** Build Bob's TransferInstruction_Accept command for a pending offer. */
  async prepareAcceptTransfer(
    streamId: string,
    selector: { transferInstructionCid?: string; cycle?: number } = {},
  ): Promise<({ prepared: true } & PreparedInstructionAction) | { prepared: false; reason: string }> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    const record = selectPendingRecord(st, selector);
    if (!record) return { prepared: false, reason: 'no_pending_offer' };
    if (record.status === 'accepted') return { prepared: false, reason: 'already_accepted' };
    if (record.status === 'withdrawn') return { prepared: false, reason: 'withdrawn' };
    const prepared = await prepareInstructionActionCommand(
      this.config,
      record,
      'accept',
      agreement.recipientParty,
      resolveInstrument(this.config, agreement).registryApiUrl,
    );
    return { prepared: true, ...prepared };
  }

  /** Record Bob's accepted transfer once Scan confirms it committed. NOW the
   * cycle counts: settled/cycles advance and StreamAdmin syncs. Idempotent. */
  async recordAcceptTransfer(
    streamId: string,
    input: { updateId: string; transferInstructionCid?: string; cycle?: number },
  ): Promise<SettleOutcome> {
    return this.runLocked(streamId, () => this.recordAcceptTransferImpl(streamId, input));
  }
  private async recordAcceptTransferImpl(
    streamId: string,
    input: { updateId: string; transferInstructionCid?: string; cycle?: number },
  ): Promise<SettleOutcome> {
    if (!input.updateId) {
      throw new V1LaneError(400, 'missing_update_id', 'updateId is required');
    }
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    store.state[streamId] = st;
    const record = selectPendingRecord(st, input);
    if (!record) {
      throw new V1LaneError(404, 'pending_offer_not_found', 'No pending transfer offer for this stream');
    }
    if (record.finalUpdateId === input.updateId || st.history.some((h) => h.updateId === input.updateId)) {
      return { settled: false, reason: 'already_recorded', cycle: st.cycles };
    }
    // The offer's own creation update carries its transfer authorization and its
    // created contract id, so it must never be accepted as the delivery.
    if (record.createUpdateId && input.updateId === record.createUpdateId) {
      throw new V1LaneError(
        422,
        'settlement_mismatch',
        `update ${input.updateId} is the offer's creation, not its acceptance; refusing to record.`,
      );
    }
    // Reject a cross-stream replay of the same on-chain update.
    if (updateIdRecordedElsewhere(store, streamId, input.updateId)) {
      throw new V1LaneError(409, 'update_replayed', `update ${input.updateId} is already recorded on another stream`);
    }
    if (record.status === 'accepted') {
      return { settled: false, reason: 'already_accepted', cycle: st.cycles };
    }

    // Bind to the exact pending offer being accepted and require the committed
    // update deliver at least the tracked amount to the recipient; credit the
    // on-chain amount, so a dust or unrelated transfer can't mark the cycle
    // accepted for the full pending figure.
    const { amount: verifiedAmount } = await verifyConsummationOnScan(configForStream(this.config, agreement), input.updateId, {
      trackedCid: record.transferInstructionCid || input.transferInstructionCid,
      recipient: agreement.recipientParty,
      minAmount: Number(record.amount),
    });
    const amount = Math.min(Number(record.amount), verifiedAmount);
    st.settled = Number((st.settled + amount).toFixed(10));
    st.cycles = Math.max(st.cycles, record.cycle);
    st.history.push({
      at: new Date().toISOString(),
      amount: amount.toFixed(10),
      ref: record.ref,
      updateId: input.updateId,
    });
    if (st.history.length > 500) st.history.splice(0, st.history.length - 500);
    record.status = 'accepted';
    record.finalUpdateId = input.updateId;
    saveStore(this.config, store);

    let adminSynced = false;
    let reason: string | undefined;
    try {
      await syncStreamAdmin(this.config, agreement, amount, input.updateId);
      adminSynced = Boolean(agreement.streamAdminCid);
    } catch (e) {
      reason = `sync_failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
    }
    return {
      settled: true,
      cycle: st.cycles,
      amount: amount.toFixed(10),
      ref: record.ref,
      updateId: input.updateId,
      adminSynced,
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * Model 1 (hosted / dev-mode recipient): the proxy FORMS and SUBMITS the
   * TransferInstruction_Accept on behalf of a recipient that is hosted on THIS
   * participant with submission rights (e.g. a validator-local party like
   * `streamsbob`, which has no browser wallet). The wallet path
   * (`prepareAcceptTransfer` + wallet submit) is for Loop/external recipients;
   * this is the counterpart when the proxy's own participant can sign for the
   * recipient. Scan-verifies before recording, exactly like the wallet path —
   * so a hosted accept is held to the same on-chain proof as a wallet accept.
   */
  async acceptTransferHosted(
    streamId: string,
    selector: { transferInstructionCid?: string; cycle?: number } = {},
  ): Promise<SettleOutcome> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    const record = selectPendingRecord(st, selector);
    if (!record) {
      throw new V1LaneError(404, 'pending_offer_not_found', 'No pending transfer offer for this stream');
    }
    if (record.status === 'accepted') return { settled: false, reason: 'already_accepted', cycle: st.cycles };
    if (record.status === 'withdrawn') return { settled: false, reason: 'withdrawn', cycle: st.cycles };
    const prepared = await prepareInstructionActionCommand(
      this.config,
      record,
      'accept',
      agreement.recipientParty,
      resolveInstrument(this.config, agreement).registryApiUrl,
    );
    const res = await submit(
      this.config,
      `accept-${record.cycle}`,
      [agreement.recipientParty],
      [prepared.command],
      prepared.disclosedContracts as unknown[],
    );
    const updateId = (res?.updateId ?? res?.transactionTree?.updateId) as string | undefined;
    if (!updateId) {
      throw new V1LaneError(502, 'submit_no_update', 'accept submitted but the ledger returned no updateId');
    }
    return this.recordAcceptTransfer(streamId, {
      updateId,
      transferInstructionCid: record.transferInstructionCid,
    });
  }

  /** Build Alice's TransferInstruction_Withdraw command to reclaim a pending
   * (unaccepted) offer — the retry path after expiry. */
  async prepareWithdrawTransfer(
    streamId: string,
    selector: { transferInstructionCid?: string; cycle?: number } = {},
  ): Promise<({ prepared: true } & PreparedInstructionAction) | { prepared: false; reason: string }> {
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    const record = selectPendingRecord(st, selector);
    if (!record) return { prepared: false, reason: 'no_pending_offer' };
    if (record.status === 'accepted') return { prepared: false, reason: 'already_accepted' };
    if (record.status === 'withdrawn') return { prepared: false, reason: 'already_withdrawn' };
    const prepared = await prepareInstructionActionCommand(
      this.config,
      record,
      'withdraw',
      agreement.payerParty,
      resolveInstrument(this.config, agreement).registryApiUrl,
    );
    return { prepared: true, ...prepared };
  }

  /** Record Alice's withdrawal once Scan confirms it. The offer is reclaimed;
   * settled/cycles are NOT advanced (no money was delivered). */
  async recordWithdrawTransfer(
    streamId: string,
    input: { updateId: string; transferInstructionCid?: string; cycle?: number },
  ): Promise<{ withdrawn: boolean; reason?: string; cycle?: number; updateId?: string }> {
    return this.runLocked(streamId, () => this.recordWithdrawTransferImpl(streamId, input));
  }
  private async recordWithdrawTransferImpl(
    streamId: string,
    input: { updateId: string; transferInstructionCid?: string; cycle?: number },
  ): Promise<{ withdrawn: boolean; reason?: string; cycle?: number; updateId?: string }> {
    if (!input.updateId) {
      throw new V1LaneError(400, 'missing_update_id', 'updateId is required');
    }
    const store = loadStore(this.config);
    const agreement = store.agreements[streamId];
    if (!agreement) {
      throw new V1LaneError(404, 'stream_not_found', `V1 stream "${streamId}" not found`);
    }
    const st = store.state[streamId] ?? emptyState();
    store.state[streamId] = st;
    const record = selectPendingRecord(st, input);
    if (!record) {
      throw new V1LaneError(404, 'pending_offer_not_found', 'No pending transfer offer for this stream');
    }
    if (record.status === 'withdrawn') {
      return { withdrawn: false, reason: 'already_withdrawn', cycle: record.cycle };
    }
    if (record.status === 'accepted') {
      return { withdrawn: false, reason: 'already_accepted', cycle: record.cycle };
    }
    // The offer's own creation update references the tracked contract too, so it
    // can't stand in for the withdrawal that consumes it.
    if (record.createUpdateId && input.updateId === record.createUpdateId) {
      throw new V1LaneError(
        422,
        'settlement_mismatch',
        `update ${input.updateId} is the offer's creation, not its withdrawal; refusing to record.`,
      );
    }
    // A withdraw reclaims the sender's locked funds — nothing is delivered to the
    // recipient, so nothing is credited. Confirm the committed update actually
    // consumed this offer, so a stray update can't mark it withdrawn.
    await verifyContractConsumedOnScan(
      this.config,
      input.updateId,
      record.transferInstructionCid || input.transferInstructionCid,
    );
    record.status = 'withdrawn';
    record.finalUpdateId = input.updateId;
    saveStore(this.config, store);
    return { withdrawn: true, cycle: record.cycle, updateId: input.updateId };
  }
}
