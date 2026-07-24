/**
 * Operator-custodied escrow lane.
 *
 * The "sign once" path for wallets that cannot vet the canton-streams DAR
 * (Loop and other custodial wallets). The payer makes ONE token-standard
 * transfer of the full amount into a dedicated, operator-controlled escrow
 * party, and this service streams it out to the payee on a schedule — no
 * further payer signature per cycle.
 *
 * Custody note: the escrow party holds the deposited funds between deposit and
 * delivery. Its keys are the validator node's keys — this is a custodial model
 * by construction. Every action is bounded on-ledger by the `OperatorEscrow`
 * contract (releases can never exceed the deposited balance) and anchored to
 * the payer's signed deposit (`fundingTransferId`). See docs/SETTLEMENT-DESIGN.md.
 *
 * Money legs reuse the V1 lane's `settleCycle` (a sender→receiver
 * token-standard transfer); the ledger record is the operator-signed
 * `OperatorEscrow` template.
 */

import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { acquireStoreLock, releaseStoreLock } from './store-lock.js';
import { requireAmount, requirePartyId, requireId } from './validation.js';
import {
  settleCycle,
  submit,
  ledger,
  prepareSettleCommand,
  prepareSettleCommandV2,
  verifyHoldingDeliveryOnScan,
  resolveInstrument,
  configForStream,
  buildOfferWithdrawCommand,
  V1LaneError,
  type V1LaneConfig,
  type V1Agreement,
  type HoldingInput,
  type PreparedSettle,
} from './v1-lane.js';
import { resolveStreamAsset } from './assets.js';

// ---------------------------------------------------------------------------
// Types + store (own state file, independent of the V1 stream store)
// ---------------------------------------------------------------------------

export type EscrowStatus = 'active' | 'completed' | 'refunded';

export interface ReleaseRecord {
  at: string;
  amount: string;
  updateId: string;
  /** Set when the cycle landed as a pending offer (payee has no preapproval). */
  pending?: boolean;
}

// ---------------------------------------------------------------------------
// Audit / flow ledger — an append-only, on-ledger-anchored record of every unit
// of value that moves through the custodial escrow, for audit + analytics.
//
// TestNet-grade honesty: entries are append-only for their MONEY facts (kind,
// from/to, amount, updateId are never rewritten). The only field reconcile
// backfills is `offerStatus` (active -> accepted/expired), a projection of the
// chain ACS. `recordTime`/`acceptUpdateId`/`acceptedAt` are reserved for a
// future Scan-anchored pass and are not populated yet. A tamper-evident
// hash-chain + immutable store are mainnet infra, not built here — the
// authoritative record remains the operator-signed OperatorEscrow contract.
// ---------------------------------------------------------------------------

export type EscrowLegKind = 'deposit' | 'release' | 'refund';
/** Direction relative to the custodian (escrow) party. */
export type EscrowLegDirection = 'in' | 'out';
/** How a leg's value landed with the receiver. */
export type EscrowDelivery = 'direct' | 'pending_offer';
/** Lifecycle of a pending offer, reconciled from the chain. */
export type EscrowOfferStatus = 'active' | 'accepted' | 'withdrawn' | 'expired';
/** Who caused the leg. */
export type EscrowInitiator = 'payer' | 'streamer' | 'operator';

export interface EscrowLedgerEntry {
  /** Monotonic per escrow (1,2,3…) — ordering + append-only integrity. */
  seq: number;
  eventId: string;
  kind: EscrowLegKind;
  direction: EscrowLegDirection;
  /** Where the value came FROM (fully-qualified party). */
  from: string;
  /** Where it went TO. For a pending offer this is the eventual payee. */
  to: string;
  /** The operator-controlled escrow party that custodies the value. */
  custodian: string;
  /** Gross amount moved, exact decimal string (never float). */
  amount: string;
  instrumentAdmin: string;
  instrumentId: string;
  /** Cadence ordinal for a release. */
  cycleNo?: number;
  /** The scheduled due time this release fired against (cadence adherence). */
  scheduledDueAt?: string;
  /** On-ledger anchor — verifiable at GET {scan}/api/scan/v2/updates/{id}. */
  updateId?: string;
  /** OperatorEscrow contract this leg advanced. */
  contractCid?: string;
  /** Set when the leg landed as a pending TransferInstruction offer. */
  transferInstructionCid?: string;
  /** A pending offer's on-ledger acceptance deadline (transfer.executeBefore) —
   * lets reconcile tell an accept (consumed in-window) from an expiry. */
  offerExpiresAt?: string;
  delivery: EscrowDelivery;
  /** Reconciled lifecycle of a pending offer (undefined for direct legs). */
  offerStatus?: EscrowOfferStatus;
  /** Reserved: populated best-effort by reconcile when a positive accept signal
   * is available; not set from ACS-exit alone (which can't prove acceptance). */
  acceptUpdateId?: string;
  acceptedAt?: string;
  initiatedBy: EscrowInitiator;
  /** For releases: the standing authority a no-signature release relied on. */
  authorizationBasis?: string;
  /** Why a terminal leg happened (e.g. payer-stop). */
  reasonCode?: string;
  /** Proxy local wall-clock — the recorded-at time. Advisory (not chain time). */
  at: string;
  /** Reserved: chain record_time from a future Scan-anchored pass. Not set yet. */
  recordTime?: string;
}

/** Computed roll-up for one escrow — separates streamed / delivered / pending /
 * refunded so in-flight value is never counted as delivered. */
export interface EscrowSummary {
  totalIn: string;
  /** Value released toward the payee (delivered + still-pending). */
  totalStreamed: string;
  /** Value the payee actually holds (direct deliveries + accepted offers). */
  totalDelivered: string;
  /** Value that left escrow into un-accepted offers (undelivered, at risk). */
  totalPending: string;
  /** Unspent balance the payer has actually received back (direct/accepted). */
  totalRefunded: string;
  /** Refund that left escrow as an un-accepted offer — at risk, not yet the payer's. */
  totalRefundPending: string;
  /** Unstreamed balance still held in custody (includes any reverted/expired legs). */
  remaining: string;
  cyclesReleased: number;
  cyclesDelivered: number;
  cyclesPending: number;
  firstReleaseAt?: string;
  lastReleaseAt?: string;
}

/** An escrow plus its computed audit summary, as returned by the API. */
export type EscrowAgreementView = EscrowAgreement & { summary: EscrowSummary };

/** Result of reconciling the off-ledger audit trail against the chain. */
export interface EscrowReconciliation {
  at: string;
  escrowId: string;
  offLedger: {
    totalStreamed: string;
    totalDelivered: string;
    totalPending: string;
    totalRefunded: string;
    remaining: string;
  };
  onLedger: {
    operatorEscrowCid?: string;
    operatorReleased?: string;
    operatorTotalDeposited?: string;
    operatorStatus?: string;
    /** Whether the custodian holds at least this escrow's remaining. The absolute
     * pool balance is commingled across escrows, so it is not exposed. */
    custodianSolvent?: boolean;
    commingled: boolean;
  };
  offers: Array<{
    seq: number;
    kind: EscrowLegKind;
    cycleNo?: number;
    transferInstructionCid: string;
    amount: string;
    to: string;
    status: EscrowOfferStatus;
  }>;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface EscrowAgreement {
  escrowId: string;
  /** The wallet that funded the escrow (recorded only; not a stakeholder). */
  originalPayer: string;
  recipient: string;
  /** Whitelisted asset key this vault streams ('cc' or absent ⇒ Canton Coin). */
  assetKey?: string;
  /** Settlement instrument frozen at create time; absent ⇒ the global CC asset,
   *  so a CC vault settles + reconciles exactly as before. Drives which
   *  registry, holding template, transfer version, and custody pool apply. */
  instrument?: V1Agreement['instrument'];
  /** Amount released per cycle. */
  ratePerCycle: string;
  cadenceSeconds: number;
  /** Total the payer deposited into the escrow party. */
  totalDeposited: string;
  /** Amount streamed to the payee so far. */
  released: string;
  /** Consecutive releases reclaimed because they expired unaccepted (non-CC only).
   *  When this reaches MAX_DELIVERY_STALLS the streamer stops auto-releasing to a
   *  payee that never accepts, so it can't churn a release+withdraw every cadence
   *  forever; reset to 0 once reconcile sees a delivery. */
  deliveryStalls?: number;
  /** updateId of the payer's signed deposit transfer (intent receipt). */
  fundingTransferId: string;
  /** Contract id of the on-ledger OperatorEscrow record. */
  operatorEscrowCid?: string;
  status: EscrowStatus;
  createdAt: string;
  /** Wall-clock at which the next cycle becomes due. */
  nextDueAt: string;
  lastReleaseAt?: string;
  releases: ReleaseRecord[];
  /** Append-only audit/flow ledger (see EscrowLedgerEntry). */
  ledger: EscrowLedgerEntry[];
}

interface EscrowStore {
  escrows: Record<string, EscrowAgreement>;
}

function escrowStateFile(config: V1LaneConfig): string {
  return config.stateFile.replace(/\.json$/i, '') + '-escrow.json';
}

function loadEscrows(config: V1LaneConfig): EscrowStore {
  const f = escrowStateFile(config);
  if (!existsSync(f)) return { escrows: {} };
  const raw = readFileSync(f, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return { escrows: parsed.escrows ?? {} };
  } catch {
    // A parse failure of a non-empty file means the store is corrupt, not absent.
    // Overwriting it with {} would discard every escrow record, so fail loud.
    if (raw.trim() !== '') {
      throw new V1LaneError(
        500,
        'escrow_store_corrupt',
        `escrow store ${f} exists but is unparseable; refusing to overwrite it`,
      );
    }
    return { escrows: {} };
  }
}

function saveEscrows(config: V1LaneConfig, store: EscrowStore): void {
  // Write to a temp file then rename, so a crash mid-write can't truncate the
  // live store (rename is atomic on the same filesystem).
  const f = escrowStateFile(config);
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, f);
}

/** After this many consecutive reclaimed (expired-unaccepted) releases, the
 * streamer stops auto-releasing to a payee that never accepts, so a preapproval-
 * less recipient can't make one vault churn a release+withdraw every cadence. */
const MAX_DELIVERY_STALLS = 3;

const dec = (x: string | number): string => Number(x).toFixed(10);
const remainingOf = (e: EscrowAgreement): number =>
  Math.max(0, Number(e.totalDeposited) - Number(e.released));

/** True while any release is a still-active pending offer (advanced `released`
 * but not yet accepted). Such an escrow must not be marked completed: if the
 * offer expires the funds revert to custody and the payer must still be able to
 * refund them, but a completed escrow is skipped by refund and the streamer. */
const hasPendingRelease = (e: EscrowAgreement): boolean =>
  (e.ledger ?? []).some((l) => l.kind === 'release' && l.offerStatus === 'active');

function escrowLockFile(config: V1LaneConfig): string {
  return escrowStateFile(config).replace(/\.json$/i, '') + '.lock';
}

/** Minimal synthetic agreement so `settleCycle` can fire a sender→receiver
 * transfer for any pair of parties (deposit, release, refund legs). Carrying the
 * escrow's `instrument` makes settleCycle resolve the right asset, registry, and
 * transfer version; omitting it settles the global CC asset exactly as before. */
function leg(
  payer: string,
  recipient: string,
  id: string,
  instrument?: V1Agreement['instrument'],
): V1Agreement {
  return {
    agreementId: id,
    payerParty: payer,
    recipientParty: recipient,
    ratePerPeriod: '0',
    cadence: 'minute',
    effectiveFrom: new Date().toISOString(),
    arrearsPolicy: 'catch-up',
    ...(instrument ? { instrument } : {}),
  };
}

/** Resolve a vault's effective settlement asset. A vault with no instrument
 * (every CC vault) resolves to the global CC config, so its money leg, audit
 * stamp, and custody pool are byte-for-byte unchanged. `key` groups vaults into
 * per-asset custody pools for the solvency interlock + cap. */
function assetOf(
  config: V1LaneConfig,
  e: Pick<EscrowAgreement, 'assetKey' | 'instrument' | 'escrowId' | 'originalPayer' | 'recipient' | 'createdAt'>,
): ReturnType<typeof resolveInstrument> & { key: string } {
  const inst = resolveInstrument(config, leg(e.originalPayer, e.recipient, e.escrowId, e.instrument));
  return { ...inst, key: (e.assetKey || 'cc').trim() || 'cc' };
}

/** Per-asset custody cap (units of that asset). CC uses the existing
 * ESCROW_MAX_TOTAL_CC; a non-CC key uses ESCROW_MAX_TOTAL_<KEY> (0 ⇒ disabled). */
function capForAsset(config: V1LaneConfig, key: string): number {
  if (key === 'cc') return config.escrowMaxTotalCC;
  const raw = process.env[`ESCROW_MAX_TOTAL_${key.toUpperCase()}`];
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Total still owed, grouped by asset key — each key is an independent custody
 * pool (the interlock protects depositors within the same asset, never across
 * assets, since one asset's balance can't cover another's obligation). */
function owedByAsset(config: V1LaneConfig, store: EscrowStore): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of Object.values(store.escrows)) {
    if (e.status !== 'active') continue;
    const key = assetOf(config, e).key;
    m.set(key, (m.get(key) ?? 0) + remainingOf(e));
  }
  return m;
}

// ---------------------------------------------------------------------------
// Audit/flow ledger helpers
// ---------------------------------------------------------------------------

/** Append one leg to the escrow's audit ledger, assigning its monotonic seq +
 * stable id + advisory local timestamp. Never rewrites existing entries. */
function appendLedger(
  e: EscrowAgreement,
  config: V1LaneConfig,
  entry: Omit<EscrowLedgerEntry, 'seq' | 'eventId' | 'custodian' | 'instrumentAdmin' | 'instrumentId' | 'at'> &
    Partial<Pick<EscrowLedgerEntry, 'at'>>,
): EscrowLedgerEntry {
  const seq = (e.ledger?.length ?? 0) + 1;
  const a = assetOf(config, e);
  const full: EscrowLedgerEntry = {
    seq,
    eventId: `${e.escrowId}:${seq}`,
    custodian: config.escrowParty,
    instrumentAdmin: a.admin,
    instrumentId: a.id,
    at: entry.at ?? new Date().toISOString(),
    ...entry,
  };
  (e.ledger ??= []).push(full);
  return full;
}

/** Backward-compat: synthesize a ledger for escrows created before the audit
 * layer, from their deposit + releases[] + (if refunded) the implied remainder.
 * Best-effort projection of already-recorded facts — marked reconstructed. */
function ensureLedger(e: EscrowAgreement, config: V1LaneConfig): EscrowAgreement {
  if (e.ledger && e.ledger.length > 0) return e;
  const a = assetOf(config, e);
  const ledger: EscrowLedgerEntry[] = [];
  const base = {
    custodian: config.escrowParty,
    instrumentAdmin: a.admin,
    instrumentId: a.id,
    reasonCode: 'reconstructed',
  };
  let seq = 0;
  ledger.push({
    ...base, seq: ++seq, eventId: `${e.escrowId}:${seq}`, kind: 'deposit', direction: 'in',
    from: e.originalPayer, to: config.escrowParty, amount: dec(e.totalDeposited),
    updateId: e.fundingTransferId || undefined, delivery: 'direct', initiatedBy: 'payer',
    contractCid: e.operatorEscrowCid, at: e.createdAt,
  });
  let streamed = 0;
  for (const [i, r] of (e.releases ?? []).entries()) {
    streamed += Number(r.amount);
    ledger.push({
      ...base, seq: ++seq, eventId: `${e.escrowId}:${seq}`, kind: 'release', direction: 'out',
      from: config.escrowParty, to: e.recipient, amount: dec(r.amount), cycleNo: i + 1,
      updateId: r.updateId, delivery: r.pending ? 'pending_offer' : 'direct',
      offerStatus: r.pending ? 'active' : undefined, initiatedBy: 'streamer', at: r.at,
      authorizationBasis: `standing deposit mandate (no per-cycle signature); escrow ${e.escrowId}`,
    });
  }
  if (e.status === 'refunded') {
    const refund = Math.max(0, Number(e.totalDeposited) - streamed);
    if (refund > 0) {
      ledger.push({
        ...base, seq: ++seq, eventId: `${e.escrowId}:${seq}`, kind: 'refund', direction: 'out',
        from: config.escrowParty, to: e.originalPayer, amount: dec(refund),
        delivery: 'direct', initiatedBy: 'payer', reasonCode: 'payer-stop (reconstructed)',
        at: e.lastReleaseAt ?? e.createdAt,
      });
    }
  }
  e.ledger = ledger;
  return e;
}

/** Roll up the ledger into the delivered/pending/refunded/remaining split. A
 * pending offer is delivered only once its offerStatus reconciles to accepted;
 * withdrawn offers revert to escrow (neither delivered nor pending). */
function summarize(e: EscrowAgreement): EscrowSummary {
  let totalIn = 0, delivered = 0, pending = 0, refunded = 0, refundPending = 0;
  let cyclesReleased = 0, cyclesDelivered = 0, cyclesPending = 0;
  let firstReleaseAt: string | undefined, lastReleaseAt: string | undefined;
  // A leg's value is delivered (direct or accepted offer), in-flight (pending
  // offer not yet accepted), or reverted (withdrawn/expired offer → funds back
  // in escrow). Reverted value is excluded from every "out" bucket, so it lands
  // back in `remaining` — never counted as delivered.
  const state = (l: EscrowLedgerEntry): 'delivered' | 'pending' | 'reverted' => {
    if (l.delivery === 'direct' || l.offerStatus === 'accepted') return 'delivered';
    if (l.offerStatus === 'withdrawn' || l.offerStatus === 'expired') return 'reverted';
    return 'pending';
  };
  for (const l of e.ledger ?? []) {
    const amt = Number(l.amount);
    if (l.kind === 'deposit') {
      // Only a settled deposit funds the escrow; an un-accepted deposit offer is
      // not yet in custody.
      if (state(l) === 'delivered') totalIn += amt;
    } else if (l.kind === 'release') {
      cyclesReleased++;
      firstReleaseAt ??= l.at;
      lastReleaseAt = l.at;
      const st = state(l);
      if (st === 'delivered') { delivered += amt; cyclesDelivered++; }
      else if (st === 'pending') { pending += amt; cyclesPending++; }
      // reverted → nothing (value returned to escrow, falls into `remaining`)
    } else if (l.kind === 'refund') {
      const st = state(l);
      if (st === 'delivered') refunded += amt;
      else if (st === 'pending') refundPending += amt;
      // reverted → nothing
    }
  }
  const streamed = delivered + pending;
  return {
    totalIn: dec(totalIn),
    totalStreamed: dec(streamed),
    totalDelivered: dec(delivered),
    totalPending: dec(pending),
    totalRefunded: dec(refunded),
    totalRefundPending: dec(refundPending),
    remaining: dec(Math.max(0, totalIn - streamed - refunded - refundPending)),
    cyclesReleased, cyclesDelivered, cyclesPending,
    firstReleaseAt, lastReleaseAt,
  };
}

// ---------------------------------------------------------------------------
// OperatorEscrow ledger record (operator = the escrow party, sole signatory)
// ---------------------------------------------------------------------------

async function resolveOperatorEscrowEvent(
  config: V1LaneConfig,
  escrowId: string,
): Promise<{ contractId: string; createArgument: any } | undefined> {
  const op = config.escrowParty;
  if (!op) return undefined;
  const parts = config.operatorEscrowTemplateId.split(':');
  const filterId = config.operatorEscrowTemplateId.startsWith('#')
    ? config.operatorEscrowTemplateId
    : `#canton-streams:${parts[1]}:${parts[2]}`;
  const { offset } = await ledger(config, 'GET', '/v2/state/ledger-end');
  const rows: any[] = await ledger(config, 'POST', '/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [op]: {
          cumulative: [
            { identifierFilter: { TemplateFilter: { value: { templateId: filterId, includeCreatedEventBlob: false } } } },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: offset,
  });
  const match = rows
    .map((r) => r.contractEntry?.JsActiveContract?.createdEvent)
    .filter((e: any) => e?.createArgument?.streamId === escrowId && e?.createArgument?.operator === op)
    .sort((a: any, b: any) => Number(b.createArgument.released ?? 0) - Number(a.createArgument.released ?? 0))[0];
  return match ? { contractId: match.contractId, createArgument: match.createArgument } : undefined;
}

async function createOperatorEscrow(
  config: V1LaneConfig,
  e: EscrowAgreement,
): Promise<string | undefined> {
  const a = assetOf(config, e);
  const createArgument = {
    streamId: e.escrowId,
    operator: config.escrowParty,
    payer: e.originalPayer,
    payee: e.recipient,
    instrumentId: { admin: a.admin, id: a.id },
    ratePerCycle: dec(e.ratePerCycle),
    cadenceSeconds: String(e.cadenceSeconds),
    totalDeposited: dec(e.totalDeposited),
    released: dec(e.released),
    fundingTransferId: e.fundingTransferId,
    startTime: e.createdAt,
    endTime: null,
    status: 'Active',
    observers: [],
  };
  await submit(config, 'escrow-create', [config.escrowParty], [
    { CreateCommand: { templateId: config.operatorEscrowTemplateId, createArguments: createArgument } },
  ]);
  return (await resolveOperatorEscrowEvent(config, e.escrowId))?.contractId;
}

async function recordEscrowRelease(
  config: V1LaneConfig,
  escrowId: string,
  amount: number,
  transferId: string,
): Promise<string | undefined> {
  const cid = (await resolveOperatorEscrowEvent(config, escrowId))?.contractId;
  if (!cid) return undefined;
  await submit(config, 'escrow-release', [config.escrowParty], [
    {
      ExerciseCommand: {
        templateId: config.operatorEscrowTemplateId,
        contractId: cid,
        choice: 'RecordRelease',
        choiceArgument: { amount: dec(amount), transferId, releasedAt: null },
      },
    },
  ]);
  return (await resolveOperatorEscrowEvent(config, escrowId))?.contractId;
}

async function recordEscrowRefund(
  config: V1LaneConfig,
  escrowId: string,
  refundTransferId: string,
): Promise<void> {
  const cid = (await resolveOperatorEscrowEvent(config, escrowId))?.contractId;
  if (!cid) return;
  await submit(config, 'escrow-refund', [config.escrowParty], [
    {
      ExerciseCommand: {
        templateId: config.operatorEscrowTemplateId,
        contractId: cid,
        choice: 'Refund',
        choiceArgument: { refundTransferId },
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Escrow-party TransferPreapproval — so deposits into it land instantly
// ---------------------------------------------------------------------------

const PREAPPROVAL_TID = '#splice-amulet:Splice.AmuletRules:TransferPreapproval';

function mintValidatorToken(config: V1LaneConfig, user: string): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: user, aud: config.validatorAuthAudience, exp: now + 3600, iat: now });
  const sig = createHmac('sha256', config.validatorAuthSecret)
    .update(`${head}.${body}`)
    .digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Idempotently ensure the escrow party holds a TransferPreapproval so incoming
 * deposits settle instantly. Best-effort: a failure only means deposits land as
 * pending offers the escrow party auto-accepts. Returns whether one is present. */
export async function ensureEscrowPreapproval(config: V1LaneConfig): Promise<boolean> {
  if (!config.escrowParty) return false;
  // Already have one?
  try {
    const { offset } = await ledger(config, 'GET', '/v2/state/ledger-end');
    const rows: any[] = await ledger(config, 'POST', '/v2/state/active-contracts', {
      filter: {
        filtersByParty: {
          [config.escrowParty]: {
            cumulative: [
              { identifierFilter: { TemplateFilter: { value: { templateId: PREAPPROVAL_TID, includeCreatedEventBlob: false } } } },
            ],
          },
        },
      },
      verbose: false,
      activeAtOffset: offset,
    });
    const has = rows.some(
      (r) => r.contractEntry?.JsActiveContract?.createdEvent?.createArgument?.receiver === config.escrowParty,
    );
    if (has) return true;
  } catch {
    /* fall through to create */
  }
  if (!config.validatorApiUrl || !config.validatorAuthAudience || !config.validatorAuthSecret) {
    return false;
  }
  try {
    const user = config.escrowParty.split('::')[0]!;
    const res = await fetch(`${config.validatorApiUrl}/v0/wallet/transfer-preapproval`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mintValidatorToken(config, user)}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// EscrowLane — create (deposit), release (per cycle), refund
// ---------------------------------------------------------------------------

export interface CreateEscrowInput {
  escrowId?: string;
  originalPayer: string;
  recipient: string;
  ratePerCycle: string;
  cadenceSeconds: number;
  totalDeposit: string;
  /** Whitelisted asset to custody ('cc'/absent ⇒ Canton Coin). */
  assetKey?: string;
  /** If the payer's WALLET already made the deposit transfer, its updateId.
   * When omitted, the proxy submits the deposit as `originalPayer` (only works
   * for a party this participant hosts — e.g. dev/hosted payers). */
  fundingTransferId?: string;
}

export class EscrowLane {
  constructor(private readonly config: V1LaneConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.escrowParty);
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new V1LaneError(503, 'escrow_disabled', 'Escrow lane is not configured (ESCROW_PARTY unset)');
    }
  }

  // The store is a whole-file load→mutate→save with awaits (transfers, chain
  // reads) in between, so two concurrent mutations — a streamer tick and a
  // manual API call, say — would clobber each other and duplicate ledger seqs.
  // Serialize every mutating path through this one queue.
  private mutationLock: Promise<unknown> = Promise.resolve();
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationLock.then(
      () => this.withStoreLock(fn),
      () => this.withStoreLock(fn),
    );
    this.mutationLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Hold the cross-process store lock for the duration of one mutation. The
   * in-process chain above already serializes this process, so the file lock
   * only ever contends with a second process sharing the store. Held across the
   * whole load->transfer->save section so the second process re-reads the
   * committed result instead of racing a stale snapshot. */
  private solvencyBreachStreak = 0;
  private async withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = escrowLockFile(this.config);
    // Generous enough to outlast a real release round-trip; a dead holder is
    // reclaimed immediately by pid, so this only bounds an unreadable-pid lock.
    const staleMs = Math.max(120000, (this.config.escrowTickSeconds + 60) * 1000);
    const token = await acquireStoreLock(lockPath, staleMs);
    try {
      return await fn();
    } finally {
      releaseStoreLock(lockPath, token);
    }
  }

  /** Live free balance the shared escrow custody party holds in one asset. CC is
   * read from its concrete Amulet template (the proven path, unchanged). A non-CC
   * asset is read through the standardized Holding interface view — its concrete
   * template's field layout is unknown, but the interface view exposes a uniform
   * { owner, instrumentId, amount, lock }; only unlocked holdings of the matching
   * instrument count toward free balance. */
  private async poolFreeBalance(asset: ReturnType<typeof assetOf>): Promise<number> {
    const { offset } = await ledger(this.config, 'GET', '/v2/state/ledger-end');
    if (asset.key === 'cc') {
      const AMULET = '#splice-amulet:Splice.Amulet:Amulet';
      const rows: any[] = await ledger(this.config, 'POST', '/v2/state/active-contracts', {
        filter: {
          filtersByParty: {
            [this.config.escrowParty]: {
              cumulative: [
                { identifierFilter: { TemplateFilter: { value: { templateId: AMULET, includeCreatedEventBlob: false } } } },
              ],
            },
          },
        },
        verbose: false,
        activeAtOffset: offset,
      });
      let bal = 0;
      for (const r of rows) {
        const v = (r.contractEntry?.JsActiveContract?.createdEvent?.createArgument?.amount ?? {})?.initialAmount;
        if (v !== undefined) bal += Number(v);
      }
      return bal;
    }
    const rows: any[] = await ledger(this.config, 'POST', '/v2/state/active-contracts', {
      filter: {
        filtersByParty: {
          [this.config.escrowParty]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId: this.config.holdingInterfaceId,
                      includeInterfaceView: true,
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
    let bal = 0;
    for (const r of rows) {
      const ev = r.contractEntry?.JsActiveContract?.createdEvent;
      for (const view of (ev?.interfaceViews ?? [])) {
        const vv = view?.viewValue;
        if (!vv) continue;
        const instId = vv.instrumentId ?? {};
        if (String(instId.id ?? '') !== asset.id) continue;
        if (instId.admin != null && String(instId.admin) !== asset.admin) continue;
        // Locked holdings back a pending offer already counted as owed, so they
        // are not free balance. lock === null/None ⇒ unlocked.
        if (vv.lock != null) continue;
        const amt = vv.amount;
        if (amt !== undefined) bal += Number(amt);
      }
    }
    return bal;
  }

  /** Refuse to move funds out of the shared custody party if doing so would dip
   * into balance owed to OTHER active escrows: the party must hold at least the
   * sum of every active escrow's remaining. Enforced before every release and
   * refund, so one escrow can never spend another's deposit. This is a solvency
   * interlock over the commingled party, not literal per-escrow sub-accounts
   * (which would need separate parties or an on-ledger lock). */
  private async assertPoolSolvent(store: EscrowStore, e: EscrowAgreement): Promise<void> {
    const asset = assetOf(this.config, e);
    const owed = owedByAsset(this.config, store).get(asset.key) ?? 0;
    if (owed <= 0) return;
    const pool = await this.poolFreeBalance(asset);
    if (pool + 1e-6 < owed) {
      const u = asset.key.toUpperCase();
      throw new V1LaneError(
        409,
        'escrow_pool_insolvent',
        `escrow custody balance ${pool.toFixed(4)} ${u} is below the ${owed.toFixed(4)} ${u} owed across active ${u} escrows; halting to protect other depositors`,
      );
    }
  }

  /** Continuous, read-only solvency probe. The per-action interlock only fires
   * when a release or refund is attempted; this runs on a timer so an out-of-band
   * drain of the custody party (fees, a mis-scoped transfer, holding expiry)
   * between actions is still surfaced. It never moves funds. A single breach can
   * be the ordinary release window — the on-chain debit lands before `released`
   * is persisted — so an alert is only escalated after two consecutive breached
   * probes; a transient skew clears on the next cycle, a real drain persists.
   * This detects aggregate drift only (custody < total owed); per-escrow
   * shortfalls under the commingled cushion are not visible here. Log-only: it is
   * a signal for an external pager, not an enforcement point. */
  async checkSolvency(): Promise<void> {
    if (!this.enabled) return;
    const store1 = loadEscrows(this.config);
    const owed1 = owedByAsset(this.config, store1);
    if ([...owed1.values()].every((v) => v <= 0)) {
      this.solvencyBreachStreak = 0;
      return;
    }
    // Probe each asset's pool independently — one asset's balance can never cover
    // another's obligation. Re-read owed after each balance so a probe landing in
    // a release window (chain debited before `released` persists) reads the lower
    // owed snapshot and biases an in-flight release toward not alerting; a real
    // drain trips both snapshots and, with the two-cycle streak, still fires.
    const breaches: { key: string; pool: number; owed: number; active: number }[] = [];
    for (const [key, owedBefore] of owed1) {
      if (owedBefore <= 0) continue;
      const rep = Object.values(store1.escrows).find(
        (x) => x.status === 'active' && assetOf(this.config, x).key === key,
      );
      if (!rep) continue;
      let pool: number;
      try {
        pool = await this.poolFreeBalance(assetOf(this.config, rep));
      } catch (err) {
        console.error(`escrow_solvency_probe_unreadable asset=${key} owed=${owedBefore.toFixed(4)} err=${(err as Error).message}`);
        continue;
      }
      const store2 = loadEscrows(this.config);
      const owed = Math.min(owedBefore, owedByAsset(this.config, store2).get(key) ?? 0);
      const active = Object.values(store2.escrows).filter(
        (x) => x.status === 'active' && assetOf(this.config, x).key === key,
      ).length;
      if (pool + 1e-6 < owed) breaches.push({ key, pool, owed, active });
    }
    if (breaches.length === 0) {
      this.solvencyBreachStreak = 0;
      return;
    }
    this.solvencyBreachStreak += 1;
    for (const b of breaches) {
      const u = b.key.toUpperCase();
      const line = `asset=${u} pool=${b.pool.toFixed(4)} owed=${b.owed.toFixed(4)} deficit=${(b.owed - b.pool).toFixed(4)} active=${b.active} streak=${this.solvencyBreachStreak}`;
      if (this.solvencyBreachStreak >= 2) console.error(`escrow_solvency_drift level=alert ${line}`);
      else console.warn(`escrow_solvency_drift level=warn ${line}`);
    }
  }

  /** Public escrow config — the deposit target a wallet needs to fund an escrow. */
  info(): {
    escrowParty: string;
    instrumentAdmin: string;
    instrumentId: string;
    tickSeconds: number;
  } {
    return {
      escrowParty: this.config.escrowParty,
      instrumentAdmin: this.config.ccAdminParty,
      instrumentId: this.config.instrumentId,
      tickSeconds: this.config.escrowTickSeconds,
    };
  }

  /** Form (no submit) the payer→escrow deposit transfer for the payer's WALLET to
   * sign on its own participant. Used when the payer is not hosted here (a Loop
   * wallet): the wallet submits this, then POST /escrows records the escrow with
   * the resulting updateId as `fundingTransferId`. */
  async prepareDeposit(input: {
    payer: string;
    totalDeposit: string;
    holdings?: HoldingInput[];
    assetKey?: string;
  }): Promise<PreparedSettle> {
    this.requireEnabled();
    if (!input.payer) throw new V1LaneError(400, 'missing_payer', 'payer required');
    const amount = Number(input.totalDeposit);
    if (!(amount > 0)) throw new V1LaneError(400, 'invalid_deposit', 'totalDeposit must be > 0');
    const instrument = this.instrumentForAsset(input.assetKey);
    const depositLeg = leg(input.payer, this.config.escrowParty, `deposit-${Date.now()}`, instrument);
    const prepareFn =
      resolveInstrument(this.config, depositLeg).transferVersion === 'v2'
        ? prepareSettleCommandV2
        : prepareSettleCommand;
    return prepareFn(this.config, depositLeg, amount, 0, input.holdings);
  }

  /** Resolve a whitelisted asset key to a frozen settlement instrument. Absent or
   * 'cc' ⇒ the global CC asset (no instrument stored). An unknown/unconfigured
   * key is rejected so a vault is never stood up against an unroutable asset. */
  private instrumentForAsset(assetKey?: string): V1Agreement['instrument'] {
    const key = (assetKey || '').trim();
    if (!key || key === 'cc') return undefined;
    const asset = resolveStreamAsset(key);
    if (!asset) {
      throw new V1LaneError(400, 'unknown_asset', `unknown or unconfigured asset "${key}"`);
    }
    return {
      admin: asset.instrumentAdmin,
      id: asset.instrumentId,
      holdingTemplateId: asset.holdingTemplateId || undefined,
      registryApiUrl: asset.registryApiUrl || undefined,
      transferVersion: asset.transferVersion,
      decimals: asset.decimals,
    };
  }

  /** Stand up an escrow: (deposit if needed) → create OperatorEscrow → schedule. */
  async createEscrow(input: CreateEscrowInput): Promise<EscrowAgreement> {
    return this.withLock(() => this.createEscrowImpl(input));
  }
  private async createEscrowImpl(input: CreateEscrowInput): Promise<EscrowAgreement> {
    this.requireEnabled();
    // Validate every field before any transfer or ledger write, so a bad input
    // can't fire the on-chain deposit and then fail the create, stranding funds.
    const originalPayer = requirePartyId(input.originalPayer, 'originalPayer');
    const recipient = requirePartyId(input.recipient, 'recipient');
    const totalDeposit = requireAmount(input.totalDeposit, 'totalDeposit').toString();
    const ratePerCycle = requireAmount(input.ratePerCycle, 'ratePerCycle').toString();
    const cadenceSeconds = input.cadenceSeconds;
    if (!Number.isInteger(cadenceSeconds) || cadenceSeconds <= 0) {
      throw new V1LaneError(400, 'invalid_cadence', 'cadenceSeconds must be a positive integer');
    }
    // Freeze the settlement asset before any transfer fires (unknown_asset
    // rejects here, not after the deposit). `instrument` undefined ⇒ CC, so every
    // downstream leg, verify, and cap resolves exactly as the CC vault does today.
    const instrument = this.instrumentForAsset(input.assetKey);
    const assetKey = instrument ? (input.assetKey || '').trim() : undefined;
    // A config view carrying this asset's identity but the global Scan, for the
    // deposit-delivery verify (the holding it looks for is this asset's).
    const streamCfg = instrument
      ? configForStream(this.config, leg(originalPayer, recipient, 'verify', instrument))
      : this.config;
    const assetCapKey = assetKey || 'cc';

    const escrowId = input.escrowId
      ? requireId(input.escrowId, 'escrowId')
      : `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const store = loadEscrows(this.config);
    if (store.escrows[escrowId]) throw new V1LaneError(409, 'escrow_exists', `escrow "${escrowId}" already exists`);

    // Deposit leg. Either the wallet already did it (fundingTransferId given) or
    // the proxy submits it as the payer (hosted payer only).
    let fundingTransferId = input.fundingTransferId ? requireId(input.fundingTransferId, 'fundingTransferId') : '';
    // What actually funds the escrow: the on-chain amount we verify for a
    // wallet-signed deposit, or the amount the proxy transfers otherwise.
    let depositAmount = totalDeposit;
    if (fundingTransferId) {
      // One funding id may back at most one escrow.
      for (const other of Object.values(store.escrows)) {
        if (other.fundingTransferId && other.fundingTransferId === fundingTransferId) {
          throw new V1LaneError(409, 'funding_reused', 'fundingTransferId already backs another escrow');
        }
      }
      // Verify the deposit actually DELIVERED CC into the escrow party — a created
      // holding it owns, not merely a transfer authorization — for at least the
      // requested amount, and take the verified on-chain amount as the funded
      // total. Requiring delivery (not a transfer spec) stops a locked, still-
      // withdrawable transfer instruction from being recorded as a funded deposit,
      // which would phantom-inflate the pool's owed balance and freeze it.
      const verified = await verifyHoldingDeliveryOnScan(streamCfg, fundingTransferId, {
        recipient: this.config.escrowParty,
        minAmount: Number(totalDeposit),
      });
      depositAmount = dec(verified.amount);
    }
    // Aggregate custody cap: refuse to grow the total tracked obligation beyond a
    // configured ceiling, so a single commingled key can never be trusted with
    // more than that. On the proxy-submitted path this runs before the deposit
    // transfer fires, so it gates fund movement; on the wallet-signed path the CC
    // is already on chain when we reject, so a distinct alert is logged for the
    // out-of-band refund. Disabled when the cap is 0.
    const assetCap = capForAsset(this.config, assetCapKey);
    if (assetCap > 0) {
      const owedThisAsset = owedByAsset(this.config, store).get(assetCapKey) ?? 0;
      const projected = owedThisAsset + Number(depositAmount);
      if (projected > assetCap + 1e-6) {
        if (fundingTransferId) {
          console.error(
            `escrow_cap_rejected_funded party=${this.config.escrowParty} asset=${assetCapKey} payer=${originalPayer} amount=${Number(depositAmount).toFixed(4)} fundingTransferId=${fundingTransferId} refund_required=true`,
          );
        }
        throw new V1LaneError(
          409,
          'escrow_cap_exceeded',
          `deposit of ${Number(depositAmount).toFixed(4)} ${assetCapKey.toUpperCase()} would raise tracked ${assetCapKey.toUpperCase()} escrow obligation to ${projected.toFixed(4)}, over the ${assetCap} aggregate cap`,
        );
      }
    }
    let depositPending: string | undefined;
    let depositExpires: string | undefined;
    if (!fundingTransferId) {
      const deposit = await settleCycle(
        this.config,
        leg(originalPayer, this.config.escrowParty, `${escrowId}:deposit`, instrument),
        Number(depositAmount),
        0,
      );
      fundingTransferId = deposit.updateId;
      depositPending = deposit.pendingInstructionCid;
      depositExpires = deposit.executeBefore;
    }

    const now = new Date();
    const e: EscrowAgreement = {
      escrowId,
      originalPayer,
      recipient,
      ...(assetKey ? { assetKey } : {}),
      ...(instrument ? { instrument } : {}),
      ratePerCycle: dec(ratePerCycle),
      cadenceSeconds,
      totalDeposited: dec(depositAmount),
      released: dec(0),
      fundingTransferId,
      status: 'active',
      createdAt: now.toISOString(),
      // First cycle becomes due on the next streamer tick, giving the deposit
      // time to settle into the escrow party's holdings.
      nextDueAt: now.toISOString(),
      releases: [],
      ledger: [],
    };
    e.operatorEscrowCid = await createOperatorEscrow(this.config, e);
    // Audit: the funding deposit — payer -> escrow (in). The escrow party holds a
    // TransferPreapproval so it normally lands directly.
    appendLedger(e, this.config, {
      kind: 'deposit',
      direction: 'in',
      from: originalPayer,
      to: this.config.escrowParty,
      amount: dec(depositAmount),
      updateId: fundingTransferId || undefined,
      contractCid: e.operatorEscrowCid,
      delivery: depositPending ? 'pending_offer' : 'direct',
      ...(depositPending
        ? { transferInstructionCid: depositPending, offerStatus: 'active' as const, offerExpiresAt: depositExpires }
        : {}),
      initiatedBy: 'payer',
      at: now.toISOString(),
    });
    store.escrows[escrowId] = e;
    saveEscrows(this.config, store);
    return e;
  }

  /** Release one cycle to the payee (operator-signed). Bounded by the remaining
   * deposited balance and the cadence schedule: a release is refused until
   * `nextDueAt` has passed. Advances `released` and `nextDueAt`. `initiatedBy`
   * distinguishes the automated streamer from a payer-triggered release. */
  async releaseEscrowOnce(
    escrowId: string,
    initiatedBy: EscrowInitiator = 'streamer',
  ): Promise<EscrowAgreement> {
    return this.withLock(() => this.releaseEscrowOnceImpl(escrowId, initiatedBy));
  }
  private async releaseEscrowOnceImpl(
    escrowId: string,
    initiatedBy: EscrowInitiator,
  ): Promise<EscrowAgreement> {
    this.requireEnabled();
    const store = loadEscrows(this.config);
    const e = store.escrows[escrowId];
    if (!e) throw new V1LaneError(404, 'escrow_not_found', `escrow "${escrowId}" not found`);
    if (e.status !== 'active') return e;

    // Enforce the cadence on every release path, not just the streamer, so no
    // caller can fire releases back-to-back and drain the deposit early.
    if (Date.parse(e.nextDueAt) > Date.now()) {
      throw new V1LaneError(409, 'cycle_not_due', `next release for "${escrowId}" is not due until ${e.nextDueAt}`);
    }

    const remaining = remainingOf(e);
    if (remaining <= 0) {
      // Only settle to completed once every release has actually delivered. A
      // still-active pending offer keeps the escrow open so its funds can be
      // refunded if the offer later expires; push the next check out one cadence
      // so it isn't rewritten (and re-locked) every tick while it waits.
      if (!hasPendingRelease(e)) e.status = 'completed';
      else e.nextDueAt = new Date(Date.now() + e.cadenceSeconds * 1000).toISOString();
      saveEscrows(this.config, store);
      return e;
    }
    const amount = Math.min(Number(e.ratePerCycle), remaining);
    const cycleNo = e.releases.length + 1;
    const scheduledDueAt = e.nextDueAt; // baseline for cadence-adherence

    await this.assertPoolSolvent(store, e);
    const res = await settleCycle(
      this.config,
      leg(this.config.escrowParty, e.recipient, `${escrowId}:release`, e.instrument),
      amount,
      cycleNo,
    );

    // The transfer committed (delivered, or pending-offer if the payee has no
    // preapproval); either way the funds left the escrow party's free balance.
    e.released = dec(Number(e.released) + amount);
    e.lastReleaseAt = new Date().toISOString();
    e.nextDueAt = new Date(Date.now() + e.cadenceSeconds * 1000).toISOString();
    e.releases.push({
      at: e.lastReleaseAt,
      amount: dec(amount),
      updateId: res.updateId,
      ...(res.pendingInstructionCid ? { pending: true } : {}),
    });
    let opCid = e.operatorEscrowCid;
    try {
      const cid = await recordEscrowRelease(this.config, escrowId, amount, res.updateId);
      if (cid) opCid = e.operatorEscrowCid = cid;
    } catch {
      /* ledger index is best-effort; the transfer already committed */
    }
    // Audit: escrow -> payee (out), one cadence cycle, no fresh payer signature.
    appendLedger(e, this.config, {
      kind: 'release',
      direction: 'out',
      from: this.config.escrowParty,
      to: e.recipient,
      amount: dec(amount),
      cycleNo,
      scheduledDueAt,
      updateId: res.updateId,
      contractCid: opCid,
      delivery: res.pendingInstructionCid ? 'pending_offer' : 'direct',
      ...(res.pendingInstructionCid
        ? { transferInstructionCid: res.pendingInstructionCid, offerStatus: 'active' as const, offerExpiresAt: res.executeBefore }
        : {}),
      initiatedBy,
      authorizationBasis: `standing deposit mandate (no per-cycle signature); escrow ${escrowId}`,
      at: e.lastReleaseAt,
    });
    // Complete only when nothing remains AND every release delivered. If this
    // cycle landed as a pending offer, it isn't delivered yet, so the escrow
    // stays active until reconcile confirms the accept (or reopens on expiry).
    if (remainingOf(e) <= 0 && !hasPendingRelease(e)) e.status = 'completed';
    saveEscrows(this.config, store);
    return e;
  }

  /** Refund the unspent balance to the payer and close the escrow. */
  async refundEscrow(escrowId: string): Promise<EscrowAgreementView> {
    return this.withLock(() => this.refundEscrowImpl(escrowId));
  }
  private async refundEscrowImpl(escrowId: string): Promise<EscrowAgreementView> {
    this.requireEnabled();
    const store = loadEscrows(this.config);
    const e = store.escrows[escrowId];
    if (!e) throw new V1LaneError(404, 'escrow_not_found', `escrow "${escrowId}" not found`);
    if (e.status !== 'active') return this.withSummary(ensureLedger(e, this.config));

    const remaining = remainingOf(e);
    let refundTransferId = 'none';
    let refundPending: string | undefined;
    if (remaining > 0) {
      await this.assertPoolSolvent(store, e);
      const res = await settleCycle(
        this.config,
        leg(this.config.escrowParty, e.originalPayer, `${escrowId}:refund`, e.instrument),
        remaining,
        0,
      );
      refundTransferId = res.updateId;
      refundPending = res.pendingInstructionCid;
      // Legacy: close out the raw `released` scalar. The truthful streamed /
      // refunded split lives in the audit ledger + summary, not this field.
      e.released = e.totalDeposited;
      // Audit: escrow -> payer (out), the unspent balance returned on stop.
      appendLedger(e, this.config, {
        kind: 'refund',
        direction: 'out',
        from: this.config.escrowParty,
        to: e.originalPayer,
        amount: dec(remaining),
        updateId: refundTransferId,
        delivery: refundPending ? 'pending_offer' : 'direct',
        ...(refundPending
          ? { transferInstructionCid: refundPending, offerStatus: 'active' as const, offerExpiresAt: res.executeBefore }
          : {}),
        initiatedBy: 'payer',
        reasonCode: 'payer-stop',
      });
    }
    e.status = 'refunded';
    e.nextDueAt = e.createdAt;
    try {
      await recordEscrowRefund(this.config, escrowId, refundTransferId);
    } catch {
      /* best-effort */
    }
    saveEscrows(this.config, store);
    return this.withSummary(e);
  }

  listEscrows(caller?: string): EscrowAgreementView[] {
    const store = loadEscrows(this.config);
    return Object.values(store.escrows)
      .filter((e) => !caller || e.originalPayer === caller || e.recipient === caller)
      .map((e) => this.withSummary(ensureLedger(e, this.config)));
  }

  getEscrow(escrowId: string, caller?: string): EscrowAgreementView {
    const store = loadEscrows(this.config);
    const e = store.escrows[escrowId];
    if (!e || (caller && e.originalPayer !== caller && e.recipient !== caller)) {
      throw new V1LaneError(404, 'escrow_not_found', `escrow "${escrowId}" not found`);
    }
    return this.withSummary(ensureLedger(e, this.config));
  }

  private withSummary(e: EscrowAgreement): EscrowAgreementView {
    return { ...e, summary: summarize(e) };
  }

  /**
   * Reconcile the off-ledger audit trail against the chain:
   *  - the operator-signed OperatorEscrow contract (released / total / status),
   *  - the escrow party's live Amulet free balance,
   *  - the status of each pending-offer leg.
   * Backfills each pending leg's offerStatus (a chain projection, not a rewrite
   * of the money facts) ONLY on a successful chain read. A consumed offer is
   * classified by its deadline: gone from the ACS within its executeBefore ⇒
   * accepted; gone past it ⇒ expired (funds reverted to escrow, NOT delivered).
   * An offer still in the ACS stays pending. A failed chain read leaves every
   * status untouched and reports `chainReachable:false` — never inferred.
   */
  async reconcile(escrowId: string, caller?: string): Promise<EscrowReconciliation> {
    return this.withLock(() => this.reconcileImpl(escrowId, caller));
  }
  private async reconcileImpl(escrowId: string, caller?: string): Promise<EscrowReconciliation> {
    this.requireEnabled();
    const store = loadEscrows(this.config);
    const raw = store.escrows[escrowId];
    if (!raw || (caller && raw.originalPayer !== caller && raw.recipient !== caller)) {
      throw new V1LaneError(404, 'escrow_not_found', `escrow "${escrowId}" not found`);
    }
    const e = ensureLedger(raw, this.config);

    // On-ledger authoritative record.
    const op = await resolveOperatorEscrowEvent(this.config, escrowId).catch(() => undefined);

    // Escrow party live free balance + active pending-offer cids, in this vault's
    // asset. CC reads its concrete Amulet templates; a non-CC vault reads the
    // custody balance via the Holding interface and its pending offers via the
    // standardized TransferInstruction interface (concrete template unknown).
    const asset = assetOf(this.config, e);
    let escrowFreeBalance = 0;
    const activeCids = new Set<string>();
    let acsOk = false;
    try {
      escrowFreeBalance = await this.poolFreeBalance(asset);
      const { offset } = await ledger(this.config, 'GET', '/v2/state/ledger-end');
      const tiFilters =
        asset.key === 'cc'
          ? [
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
            ]
          : [this.config.transferInstructionInterfaceId, this.config.transferInstructionInterfaceIdV2].map(
              (interfaceId) => ({
                identifierFilter: {
                  InterfaceFilter: { value: { interfaceId, includeInterfaceView: false, includeCreatedEventBlob: false } },
                },
              }),
            );
      const rows: any[] = await ledger(this.config, 'POST', '/v2/state/active-contracts', {
        filter: { filtersByParty: { [this.config.escrowParty]: { cumulative: tiFilters } } },
        verbose: false,
        activeAtOffset: offset,
      });
      for (const r of rows) {
        const cid = r.contractEntry?.JsActiveContract?.createdEvent?.contractId;
        if (cid) activeCids.add(cid);
      }
      acsOk = true; // both reads returned — the ACS snapshot is trustworthy
    } catch {
      /* leave acsOk=false: do NOT infer offer status from a partial snapshot */
    }

    // Backfill each pending-offer leg's status ONLY from a trustworthy snapshot.
    // Terminal states are immutable; the only inferred transitions are
    // active -> {accepted | expired}, decided by the offer's deadline.
    let mutated = false;
    if (acsOk) {
      const nowMs = Date.now();
      for (const l of e.ledger) {
        if (!l.transferInstructionCid) continue;
        if (l.offerStatus === 'accepted' || l.offerStatus === 'expired' || l.offerStatus === 'withdrawn') continue;
        let next: EscrowOfferStatus;
        if (activeCids.has(l.transferInstructionCid)) {
          next = 'active'; // still locked (may be past deadline but not yet swept)
        } else {
          const pastDeadline = l.offerExpiresAt ? Date.parse(l.offerExpiresAt) <= nowMs : false;
          if (pastDeadline) {
            // Past executeBefore, an accept can no longer succeed → it was swept.
            next = 'expired';
          } else if (l.direction === 'out') {
            // An outgoing offer (escrow is the sender) that leaves the ACS before
            // its deadline can only have been accepted — the operator never
            // withdraws its own releases.
            next = 'accepted';
          } else {
            // An incoming deposit offer can leave the ACS by accept OR a payer
            // withdraw; exit alone can't tell them apart, so don't infer delivery.
            next = 'active';
          }
        }
        if (l.offerStatus !== next) {
          // A release offer that reverted (expired, swept back to escrow) returns
          // its funds to custody, so undo its advance of `released` — otherwise
          // `remaining` under-counts and the funds are stranded. Reopen the escrow
          // if that release had prematurely completed it, so refund can recover.
          if (next === 'expired' && l.kind === 'release') {
            e.released = dec(Math.max(0, Number(e.released) - Number(l.amount)));
            if (e.status === 'completed') e.status = 'active';
          }
          // A confirmed delivery clears the stall counter, so a payee that starts
          // accepting resumes auto-streaming (see MAX_DELIVERY_STALLS in tick).
          if (next === 'accepted' && l.kind === 'release') e.deliveryStalls = 0;
          l.offerStatus = next;
          mutated = true;
        }
      }
      // Once the offers reconcile, an escrow that owes nothing and has no pending
      // release is done — complete it so the streamer stops revisiting it.
      if (e.status === 'active' && remainingOf(e) <= 0 && !hasPendingRelease(e)) {
        e.status = 'completed';
        mutated = true;
      }
      if (mutated) saveEscrows(this.config, store);
    }

    const sum = summarize(e);
    const dust = 1e-6;
    const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
    const checks: EscrowReconciliation['checks'] = [];

    checks.push({
      name: 'chainReachable',
      ok: acsOk,
      detail: acsOk ? 'escrow ACS + balance read from the chain' : 'chain read failed — offer statuses left unchanged; results provisional',
    });

    if (op?.createArgument) {
      const opReleased = Number(op.createArgument.released ?? 0);
      checks.push({
        name: 'releasedMatchesOnLedger',
        ok: near(opReleased, Number(sum.totalStreamed)),
        detail: `on-ledger OperatorEscrow.released=${opReleased} vs audit totalStreamed=${sum.totalStreamed}`,
      });
      const opTotal = Number(op.createArgument.totalDeposited ?? 0);
      checks.push({
        name: 'depositMatchesOnLedger',
        ok: near(opTotal, Number(sum.totalIn)),
        detail: `on-ledger totalDeposited=${opTotal} vs audit totalIn=${sum.totalIn}`,
      });
    } else {
      // Never silently drop the on-chain comparison — a reconcile that verified
      // nothing must not look green.
      checks.push({
        name: 'operatorEscrowResolved',
        ok: false,
        detail: 'could not read the OperatorEscrow contract from the chain — on-chain comparison unavailable',
      });
    }

    const conserved =
      Number(sum.totalIn) -
      Number(sum.totalStreamed) -
      Number(sum.totalRefunded) -
      Number(sum.totalRefundPending) -
      Number(sum.remaining);
    checks.push({
      name: 'valueConservation',
      ok: Math.abs(conserved) <= dust,
      detail: `totalIn - streamed - refunded - refundPending - remaining = ${conserved.toExponential(2)} (must be ~0)`,
    });

    if (acsOk) {
      // The custodian must hold at least this escrow's unstreamed remainder in
      // free balance (it is commingled, so this is a lower bound, not equality).
      checks.push({
        name: 'escrowSolvency',
        ok: escrowFreeBalance + dust >= Number(sum.remaining),
        detail: `custodian holds at least this escrow's remaining ${sum.remaining} (commingled lower bound)`,
      });
    }

    const offers = e.ledger
      .filter((l) => l.transferInstructionCid)
      .map((l) => ({
        seq: l.seq,
        kind: l.kind,
        cycleNo: l.cycleNo,
        transferInstructionCid: l.transferInstructionCid!,
        amount: l.amount,
        to: l.to,
        status: l.offerStatus ?? 'active',
      }));
    const stillActive = offers.filter((o) => o.status === 'active').length;
    const accepted = offers.filter((o) => o.status === 'accepted').length;
    const expired = offers.filter((o) => o.status === 'expired').length;
    checks.push({
      name: 'pendingOffersTracked',
      ok: true,
      detail: `${stillActive} awaiting accept · ${accepted} accepted · ${expired} expired (reverted)`,
    });

    return {
      at: new Date().toISOString(),
      escrowId,
      offLedger: {
        totalStreamed: sum.totalStreamed,
        totalDelivered: sum.totalDelivered,
        totalPending: sum.totalPending,
        totalRefunded: sum.totalRefunded,
        remaining: sum.remaining,
      },
      onLedger: {
        operatorEscrowCid: op?.contractId ?? e.operatorEscrowCid,
        operatorReleased: op?.createArgument?.released,
        operatorTotalDeposited: op?.createArgument?.totalDeposited,
        operatorStatus: op?.createArgument?.status,
        custodianSolvent: acsOk ? escrowFreeBalance + dust >= Number(sum.remaining) : undefined,
        commingled: true,
      },
      offers,
      checks,
    };
  }

  /** Contract ids of the escrow party's still-active (locked) pending offers in
   *  one asset — CC via the concrete Amulet TI template, a non-CC asset via the
   *  standardized TransferInstruction interface (concrete template unknown). */
  private async activeOfferCids(asset: ReturnType<typeof assetOf>): Promise<Set<string>> {
    const { offset } = await ledger(this.config, 'GET', '/v2/state/ledger-end');
    const filters =
      asset.key === 'cc'
        ? [
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
          ]
        : [this.config.transferInstructionInterfaceId, this.config.transferInstructionInterfaceIdV2].map(
            (interfaceId) => ({
              identifierFilter: {
                InterfaceFilter: { value: { interfaceId, includeInterfaceView: false, includeCreatedEventBlob: false } },
              },
            }),
          );
    const rows: any[] = await ledger(this.config, 'POST', '/v2/state/active-contracts', {
      filter: { filtersByParty: { [this.config.escrowParty]: { cumulative: filters } } },
      verbose: false,
      activeAtOffset: offset,
    });
    const s = new Set<string>();
    for (const r of rows) {
      const cid = r.contractEntry?.JsActiveContract?.createdEvent?.contractId;
      if (cid) s.add(cid);
    }
    return s;
  }

  /** Reclaim the funds of any release that expired while still locked on-ledger:
   *  a receiver with no preapproval never accepted it, and — unlike CC — a general
   *  asset has no DSO auto-sweep, so the funds would otherwise strand in the dead
   *  offer. The custodian is the release's sender, so it withdraws the offer
   *  (exercisable at any time, incl. post-executeBefore), returning the value to
   *  custody where it re-enters `remaining` for a re-release or refund. CC is a
   *  no-op — its expired offers auto-sweep and reconcile already reverts them. */
  async reclaimExpiredReleases(escrowId: string): Promise<{ reclaimed: number }> {
    return this.withLock(() => this.reclaimExpiredReleasesImpl(escrowId));
  }
  private async reclaimExpiredReleasesImpl(escrowId: string): Promise<{ reclaimed: number }> {
    this.requireEnabled();
    const store = loadEscrows(this.config);
    const e = store.escrows[escrowId];
    if (!e) throw new V1LaneError(404, 'escrow_not_found', `escrow "${escrowId}" not found`);
    const asset = assetOf(this.config, e);
    if (asset.key === 'cc') return { reclaimed: 0 };
    // A refunded vault has already returned its balance to the payer; reclaiming a
    // still-locked release into custody there has no disbursement path, so leave it
    // in the (recoverable) offer rather than strand it in the commingled pool.
    // active + completed proceed (completed reopens below so refund can recover it).
    if (e.status === 'refunded') return { reclaimed: 0 };
    const nowMs = Date.now();
    const stuck = (e.ledger ?? []).filter(
      (l) =>
        l.kind === 'release' &&
        l.offerStatus === 'active' &&
        l.transferInstructionCid &&
        l.offerExpiresAt &&
        Date.parse(l.offerExpiresAt) <= nowMs,
    );
    if (stuck.length === 0) return { reclaimed: 0 };
    const active = await this.activeOfferCids(asset);
    let reclaimed = 0;
    let mutated = false;
    for (const l of stuck) {
      // Only withdraw an offer still locked on-ledger; one already gone is left to
      // reconcile (accepted before its deadline, or previously reclaimed).
      if (!active.has(l.transferInstructionCid!)) continue;
      try {
        const { command, disclosedContracts } = await buildOfferWithdrawCommand(
          this.config,
          l.transferInstructionCid!,
          asset.registryApiUrl,
        );
        await submit(this.config, `escrow-reclaim-${l.seq}`, [this.config.escrowParty], [command], disclosedContracts);
      } catch (err) {
        console.warn(`[escrow] reclaim failed for ${escrowId} seq=${l.seq}: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
        continue;
      }
      // Withdraw committed → funds back in custody. Revert the release and
      // un-advance `released` once (reconcile skips terminal statuses, so no
      // double-count), reopening the escrow if this release had completed it.
      l.offerStatus = 'withdrawn';
      e.released = dec(Math.max(0, Number(e.released) - Number(l.amount)));
      if (e.status === 'completed') e.status = 'active';
      e.deliveryStalls = (e.deliveryStalls ?? 0) + 1;
      reclaimed += 1;
      mutated = true;
    }
    if (mutated) saveEscrows(this.config, store);
    return { reclaimed };
  }

  /** One streamer pass: release every active escrow whose next cycle is due, then
   * reclaim any non-CC release that expired locked (no auto-sweep for general
   * assets), so stuck funds return to custody instead of stranding. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    const store = loadEscrows(this.config);
    const now = Date.now();
    const active = Object.values(store.escrows).filter((e) => e.status === 'active');
    for (const e of active) {
      if (Date.parse(e.nextDueAt) > now) continue;
      // A payee that never accepts (no preapproval) would otherwise churn a
      // release+reclaim every cadence; pause auto-release after repeated stalls
      // (the payer can still refund, and a delivery resets the counter).
      if ((e.deliveryStalls ?? 0) >= MAX_DELIVERY_STALLS) {
        console.warn(
          `escrow_delivery_stalled escrow=${e.escrowId} stalls=${e.deliveryStalls} — auto-release paused; refund or enable recipient preapproval`,
        );
        continue;
      }
      try {
        await this.releaseEscrowOnce(e.escrowId);
      } catch (err) {
        // Non-fatal: log and retry on the next tick (e.g. transient insufficient
        // holdings while a prior transfer settles).
        console.warn(`[escrow] release failed for ${e.escrowId}:`, String((err as Error)?.message ?? err).slice(0, 200));
      }
    }
    for (const e of active) {
      if ((e.assetKey || 'cc') === 'cc') continue;
      try {
        await this.reclaimExpiredReleases(e.escrowId);
      } catch (err) {
        console.warn(`[escrow] reclaim sweep failed for ${e.escrowId}:`, String((err as Error)?.message ?? err).slice(0, 160));
      }
    }
  }
}

/** Start the background streamer. Returns a stop function. */
export function startEscrowStreamer(lane: EscrowLane, config: V1LaneConfig): () => void {
  if (!lane.enabled) return () => {};
  const ms = Math.max(5, config.escrowTickSeconds) * 1000;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void lane.tick().finally(() => {
      running = false;
    });
  }, ms);
  return () => clearInterval(timer);
}

/** Run the continuous solvency drift probe on its own cadence (default: the
 * streamer tick, floor 10s). Read-only; emits `escrow_solvency_drift` for an
 * external pager to watch. Returns a stop function. */
export function startEscrowSolvencyMonitor(lane: EscrowLane, config: V1LaneConfig): () => void {
  if (!lane.enabled) return () => {};
  const ms = Math.max(10, config.solvencyMonitorSeconds || config.escrowTickSeconds) * 1000;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void lane
      .checkSolvency()
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  }, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}
