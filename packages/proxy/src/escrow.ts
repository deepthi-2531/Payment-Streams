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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  settleCycle,
  submit,
  ledger,
  V1LaneError,
  type V1LaneConfig,
  type V1Agreement,
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
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    return { escrows: raw.escrows ?? {} };
  } catch {
    return { escrows: {} };
  }
}

function saveEscrows(config: V1LaneConfig, store: EscrowStore): void {
  writeFileSync(escrowStateFile(config), JSON.stringify(store, null, 2));
}

const dec = (x: string | number): string => Number(x).toFixed(10);
const remainingOf = (e: EscrowAgreement): number =>
  Math.max(0, Number(e.totalDeposited) - Number(e.released));

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

  /** Stand up an escrow: (deposit if needed) → create OperatorEscrow → schedule. */
  async createEscrow(input: CreateEscrowInput): Promise<EscrowAgreement> {
    this.requireEnabled();
    if (!input.originalPayer) throw new V1LaneError(400, 'missing_payer', 'originalPayer required');
    if (!input.recipient) throw new V1LaneError(400, 'missing_recipient', 'recipient required');
    if (!(Number(input.totalDeposit) > 0)) throw new V1LaneError(400, 'invalid_deposit', 'totalDeposit must be > 0');
    if (!(Number(input.ratePerCycle) > 0)) throw new V1LaneError(400, 'invalid_rate', 'ratePerCycle must be > 0');

    const escrowId = input.escrowId ?? `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const store = loadEscrows(this.config);
    if (store.escrows[escrowId]) throw new V1LaneError(409, 'escrow_exists', `escrow "${escrowId}" already exists`);

    // Deposit leg. Either the wallet already did it (fundingTransferId given) or
    // the proxy submits it as the payer (hosted payer only).
    let fundingTransferId = input.fundingTransferId ?? '';
    if (!fundingTransferId) {
      const deposit = await settleCycle(
        this.config,
        leg(input.originalPayer, this.config.escrowParty, `${escrowId}:deposit`),
        Number(input.totalDeposit),
        0,
      );
      fundingTransferId = deposit.updateId;
    }

    const now = new Date();
    const e: EscrowAgreement = {
      escrowId,
      originalPayer: input.originalPayer,
      recipient: input.recipient,
      ratePerCycle: dec(input.ratePerCycle),
      cadenceSeconds: input.cadenceSeconds,
      totalDeposited: dec(input.totalDeposit),
      released: dec(0),
      fundingTransferId,
      status: 'active',
      createdAt: now.toISOString(),
      // First cycle becomes due on the next streamer tick, giving the deposit
      // time to settle into the escrow party's holdings.
      nextDueAt: now.toISOString(),
      releases: [],
    };
    e.operatorEscrowCid = await createOperatorEscrow(this.config, e);
    store.escrows[escrowId] = e;
    saveEscrows(this.config, store);
    return e;
  }

  /** Release one cycle to the payee (operator-signed). Bounded by the remaining
   * deposited balance; advances `released` and the schedule. Idempotent per
   * tick via `nextDueAt`. */
  async releaseEscrowOnce(escrowId: string): Promise<EscrowAgreement> {
    this.requireEnabled();
    const store = loadEscrows(this.config);
    const e = store.escrows[escrowId];
    if (!e) throw new V1LaneError(404, 'escrow_not_found', `escrow "${escrowId}" not found`);
    if (e.status !== 'active') return e;

    const remaining = remainingOf(e);
    if (remaining <= 0) {
      e.status = 'completed';
      saveEscrows(this.config, store);
      return e;
    }
    const amount = Math.min(Number(e.ratePerCycle), remaining);

    const res = await settleCycle(
      this.config,
      leg(this.config.escrowParty, e.recipient, `${escrowId}:release`),
      amount,
      e.releases.length + 1,
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
    try {
      const cid = await recordEscrowRelease(this.config, escrowId, amount, res.updateId);
      if (cid) e.operatorEscrowCid = cid;
    } catch {
      /* ledger index is best-effort; the transfer already committed */
    }
    if (remainingOf(e) <= 0) e.status = 'completed';
    saveEscrows(this.config, store);
    return e;
  }

  /** Refund the unspent balance to the payer and close the escrow. */
  async refundEscrow(escrowId: string): Promise<EscrowAgreement> {
    this.requireEnabled();
    const store = loadEscrows(this.config);
    const e = store.escrows[escrowId];
    if (!e) throw new V1LaneError(404, 'escrow_not_found', `escrow "${escrowId}" not found`);
    if (e.status !== 'active') return e;

    const remaining = remainingOf(e);
    let refundTransferId = 'none';
    if (remaining > 0) {
      const res = await settleCycle(
        this.config,
        leg(this.config.escrowParty, e.originalPayer, `${escrowId}:refund`),
        remaining,
        0,
      );
      refundTransferId = res.updateId;
      // Mark the refunded balance as released so accounting closes out.
      e.released = e.totalDeposited;
    }
    e.status = 'refunded';
    e.nextDueAt = e.createdAt;
    try {
      await recordEscrowRefund(this.config, escrowId, refundTransferId);
    } catch {
      /* best-effort */
    }
    saveEscrows(this.config, store);
    return e;
  }

  listEscrows(caller?: string): EscrowAgreement[] {
    const store = loadEscrows(this.config);
    return Object.values(store.escrows).filter(
      (e) => !caller || e.originalPayer === caller || e.recipient === caller,
    );
  }

  getEscrow(escrowId: string, caller?: string): EscrowAgreement {
    const store = loadEscrows(this.config);
    const e = store.escrows[escrowId];
    if (!e || (caller && e.originalPayer !== caller && e.recipient !== caller)) {
      throw new V1LaneError(404, 'escrow_not_found', `escrow "${escrowId}" not found`);
    }
    return e;
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
