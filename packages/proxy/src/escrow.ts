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
  V1LaneError,
  type V1LaneConfig,
  type V1Agreement,
  type HoldingInput,
  type PreparedSettle,
} from './v1-lane.js';

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
  /** Amount released per cycle. */
  ratePerCycle: string;
  cadenceSeconds: number;
  /** Total the payer deposited into the escrow party. */
  totalDeposited: string;
  /** Amount streamed to the payee so far. */
  released: string;
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

const dec = (x: string | number): string => Number(x).toFixed(10);
const remainingOf = (e: EscrowAgreement): number =>
  Math.max(0, Number(e.totalDeposited) - Number(e.released));

/** True while any release is a still-active pending offer (advanced `released`
 * but not yet accepted). Such an escrow must not be marked completed: if the
 * offer expires the funds revert to custody and the payer must still be able to
 * refund them, but a completed escrow is skipped by refund and the streamer. */
const hasPendingRelease = (e: EscrowAgreement): boolean =>
  (e.ledger ?? []).some((l) => l.kind === 'release' && l.offerStatus === 'active');

/** Total still owed across every active escrow — the floor the custody party
 * must always be able to cover. Shared by the per-action solvency interlock and
 * the continuous drift monitor so both read the same number. */
const sumOwed = (store: EscrowStore): number =>
  Object.values(store.escrows)
    .filter((x) => x.status === 'active')
    .reduce((s, x) => s + remainingOf(x), 0);

function escrowLockFile(config: V1LaneConfig): string {
  return escrowStateFile(config).replace(/\.json$/i, '') + '.lock';
}

/** Minimal synthetic agreement so `settleCycle` can fire a sender→receiver
 * transfer for any pair of parties (deposit, release, refund legs). */
function leg(payer: string, recipient: string, id: string): V1Agreement {
  return {
    agreementId: id,
    payerParty: payer,
    recipientParty: recipient,
    ratePerPeriod: '0',
    cadence: 'minute',
    effectiveFrom: new Date().toISOString(),
    arrearsPolicy: 'catch-up',
  };
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
  const full: EscrowLedgerEntry = {
    seq,
    eventId: `${e.escrowId}:${seq}`,
    custodian: config.escrowParty,
    instrumentAdmin: config.ccAdminParty,
    instrumentId: config.instrumentId,
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
  const ledger: EscrowLedgerEntry[] = [];
  const base = {
    custodian: config.escrowParty,
    instrumentAdmin: config.ccAdminParty,
    instrumentId: config.instrumentId,
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
  const createArgument = {
    streamId: e.escrowId,
    operator: config.escrowParty,
    payer: e.originalPayer,
    payee: e.recipient,
    instrumentId: { admin: config.ccAdminParty, id: config.instrumentId },
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

  /** Live free CC balance held by the shared escrow custody party. */
  private async poolFreeBalance(): Promise<number> {
    const AMULET = '#splice-amulet:Splice.Amulet:Amulet';
    const { offset } = await ledger(this.config, 'GET', '/v2/state/ledger-end');
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

  /** Refuse to move funds out of the shared custody party if doing so would dip
   * into balance owed to OTHER active escrows: the party must hold at least the
   * sum of every active escrow's remaining. Enforced before every release and
   * refund, so one escrow can never spend another's deposit. This is a solvency
   * interlock over the commingled party, not literal per-escrow sub-accounts
   * (which would need separate parties or an on-ledger lock). */
  private async assertPoolSolvent(store: EscrowStore): Promise<void> {
    const owed = sumOwed(store);
    if (owed <= 0) return;
    const pool = await this.poolFreeBalance();
    if (pool + 1e-6 < owed) {
      throw new V1LaneError(
        409,
        'escrow_pool_insolvent',
        `escrow custody balance ${pool.toFixed(4)} CC is below the ${owed.toFixed(4)} CC owed across active escrows; halting to protect other depositors`,
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
    const owedBefore = sumOwed(loadEscrows(this.config));
    if (owedBefore <= 0) {
      this.solvencyBreachStreak = 0;
      return;
    }
    let pool: number;
    try {
      pool = await this.poolFreeBalance();
    } catch (err) {
      console.error(`escrow_solvency_probe_unreadable owed=${owedBefore.toFixed(4)} err=${(err as Error).message}`);
      return;
    }
    // Re-read owed after the balance. A release debits the chain before it
    // persists `released`, so a probe landing in that window would otherwise read
    // a debited pool against a stale-high owed. Taking the lower of the two owed
    // snapshots biases an in-flight release toward not alerting; a real persistent
    // drain trips both snapshots and, with the two-cycle streak, still fires.
    const store = loadEscrows(this.config);
    const owed = Math.min(owedBefore, sumOwed(store));
    const active = Object.values(store.escrows).filter((x) => x.status === 'active').length;
    if (pool + 1e-6 < owed) {
      this.solvencyBreachStreak += 1;
      const deficit = (owed - pool).toFixed(4);
      if (this.solvencyBreachStreak >= 2) {
        console.error(
          `escrow_solvency_drift level=alert pool=${pool.toFixed(4)} owed=${owed.toFixed(4)} deficit=${deficit} active=${active} streak=${this.solvencyBreachStreak}`,
        );
      } else {
        console.warn(
          `escrow_solvency_drift level=warn pool=${pool.toFixed(4)} owed=${owed.toFixed(4)} deficit=${deficit} active=${active}`,
        );
      }
    } else {
      this.solvencyBreachStreak = 0;
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
  }): Promise<PreparedSettle> {
    this.requireEnabled();
    if (!input.payer) throw new V1LaneError(400, 'missing_payer', 'payer required');
    const amount = Number(input.totalDeposit);
    if (!(amount > 0)) throw new V1LaneError(400, 'invalid_deposit', 'totalDeposit must be > 0');
    const prepareFn =
      this.config.transferVersion === 'v2' ? prepareSettleCommandV2 : prepareSettleCommand;
    return prepareFn(
      this.config,
      leg(input.payer, this.config.escrowParty, `deposit-${Date.now()}`),
      amount,
      0,
      input.holdings,
    );
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
      const verified = await verifyHoldingDeliveryOnScan(this.config, fundingTransferId, {
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
    if (this.config.escrowMaxTotalCC > 0) {
      const projected = sumOwed(store) + Number(depositAmount);
      if (projected > this.config.escrowMaxTotalCC + 1e-6) {
        if (fundingTransferId) {
          console.error(
            `escrow_cap_rejected_funded party=${this.config.escrowParty} payer=${originalPayer} amount=${Number(depositAmount).toFixed(4)} fundingTransferId=${fundingTransferId} refund_required=true`,
          );
        }
        throw new V1LaneError(
          409,
          'escrow_cap_exceeded',
          `deposit of ${Number(depositAmount).toFixed(4)} CC would raise tracked escrow obligation to ${projected.toFixed(4)} CC, over the ${this.config.escrowMaxTotalCC} CC aggregate cap`,
        );
      }
    }
    let depositPending: string | undefined;
    let depositExpires: string | undefined;
    if (!fundingTransferId) {
      const deposit = await settleCycle(
        this.config,
        leg(originalPayer, this.config.escrowParty, `${escrowId}:deposit`),
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

    await this.assertPoolSolvent(store);
    const res = await settleCycle(
      this.config,
      leg(this.config.escrowParty, e.recipient, `${escrowId}:release`),
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
      await this.assertPoolSolvent(store);
      const res = await settleCycle(
        this.config,
        leg(this.config.escrowParty, e.originalPayer, `${escrowId}:refund`),
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

    // Escrow party live free balance + active pending-offer cids.
    const AMULET = '#splice-amulet:Splice.Amulet:Amulet';
    const TI = '#splice-amulet:Splice.AmuletTransferInstruction:AmuletTransferInstruction';
    let escrowFreeBalance = 0;
    const activeCids = new Set<string>();
    let acsOk = false;
    try {
      const { offset } = await ledger(this.config, 'GET', '/v2/state/ledger-end');
      const q = async (tid: string): Promise<any[]> =>
        ledger(this.config, 'POST', '/v2/state/active-contracts', {
          filter: {
            filtersByParty: {
              [this.config.escrowParty]: {
                cumulative: [
                  { identifierFilter: { TemplateFilter: { value: { templateId: tid, includeCreatedEventBlob: false } } } },
                ],
              },
            },
          },
          verbose: false,
          activeAtOffset: offset,
        });
      for (const r of await q(AMULET)) {
        const v = (r.contractEntry?.JsActiveContract?.createdEvent?.createArgument?.amount ?? {})?.initialAmount;
        if (v !== undefined) escrowFreeBalance += Number(v);
      }
      for (const r of await q(TI)) {
        const cid = r.contractEntry?.JsActiveContract?.createdEvent?.contractId;
        if (cid) activeCids.add(cid);
      }
      acsOk = true; // both queries returned — the ACS snapshot is trustworthy
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

  /** One streamer pass: release every active escrow whose next cycle is due. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    const store = loadEscrows(this.config);
    const now = Date.now();
    const due = Object.values(store.escrows).filter(
      (e) => e.status === 'active' && Date.parse(e.nextDueAt) <= now,
    );
    for (const e of due) {
      try {
        await this.releaseEscrowOnce(e.escrowId);
      } catch (err) {
        // Non-fatal: log and retry on the next tick (e.g. transient insufficient
        // holdings while a prior transfer settles).
        console.warn(`[escrow] release failed for ${e.escrowId}:`, String((err as Error)?.message ?? err).slice(0, 200));
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
