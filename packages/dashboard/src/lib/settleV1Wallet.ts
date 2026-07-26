/**
 * Model 2 — wallet-submitted V1 settle.
 *
 * For a payer whose key is held by a hosted wallet (Loop/PartyLayer), the
 * transfer must be signed and submitted through the WALLET'S OWN participant,
 * not the BitDynamics proxy. The proxy can't read or sign for that party.
 *
 * Flow (one cycle):
 *   1. read the payer's spendable Amulet holdings from the wallet's participant;
 *   2. ask the proxy to FORM the TransferFactory_Transfer (it owns the registry
 *      choice-context call, which needs the validator's whitelisted egress);
 *   3. the payer's wallet submits that command via /v2/commands/submit-and-wait
 *      (the user approves in the wallet popup), signing with its own key;
 *   4. tell the proxy the cycle committed (idempotent on the updateId).
 *
 * No custom DAR, no BitDynamics hosting of the payer — this is the "any party,
 * any participant" path the V1 token-standard lane is designed for.
 *
 * Receiver-claim helpers in this file are intentionally opt-in. They create
 * `ReceiverClaimV1` from the `canton-streams-v1-shim` package, so the payer's
 * participant must vet that DAR. Hosted wallets such as Loop generally will not
 * have our DAR vetted; use direct delivery for public TestNet demos.
 */

import {
  HoldingsEmptyError,
  queryActiveContractsRaw,
  queryActiveContractsByInterfaceRaw,
  submitAndWait,
  fetchUpdateById,
} from './hostedWalletLedger.js';
import type {
  V1TransferProof,
  V1PreparedAllocation,
  V1PreparedClaim,
  V1PreparedInstructionAction,
  V1PreparedReceiverClaim,
  V1PrepareSettleParams,
  V1PreparedSettle,
  V1PendingSelector,
  V1PendingTransferRecord,
  V1ReceiverClaimRecord,
  V1RecordAllocationParams,
  V1RecordClaimParams,
  V1RecordInstructionParams,
  V1RecordReceiverClaimParams,
  V1RecordSettleParams,
  V1SettleResult,
  V1WithdrawResult,
} from '../api/client.js';

/** Amulet holding template in Loop's `#package:module:entity` form. */
const AMULET_TID = '#splice-amulet:Splice.Amulet:Amulet';
/** Token-standard Holding interface — lets us read a non-CC asset's holdings
 *  (e.g. USDCx) by interface when its concrete template id isn't configured. */
const HOLDING_INTERFACE_ID = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';
const AMULET_ALLOCATION_TID = '#splice-amulet:Splice.AmuletAllocation:AmuletAllocation';
const RECEIVER_CLAIM_TID =
  '#canton-streams-v1-shim:CantonStreams.V1Shim.ReceiverClaim:ReceiverClaimV1';

/** A payer holding the cycle will draw from: contract id + decimal amount. */
interface Holding {
  cid: string;
  amount: number;
}

/** The two proxy calls this orchestrator needs from the API client. */
export interface V1WalletSettleClient {
  prepareSettleV1(id: string, body: V1PrepareSettleParams): Promise<V1PreparedSettle>;
  recordSettleV1(id: string, body: V1RecordSettleParams): Promise<V1SettleResult>;
  recoverPendingV1(id: string): Promise<{ recovered: V1PendingTransferRecord[] }>;
  prepareAllocationV1(
    id: string,
    body: V1PrepareSettleParams & { executor?: string; unlockAt?: string; expiresAt?: string },
  ): Promise<V1PreparedAllocation>;
  recordAllocationV1(id: string, body: V1RecordAllocationParams): Promise<V1ReceiverClaimRecord>;
  prepareReceiverClaimV1(
    id: string,
    body: { cycle?: number; allocationCid?: string },
  ): Promise<V1PreparedReceiverClaim>;
  recordReceiverClaimV1(
    id: string,
    body: V1RecordReceiverClaimParams,
  ): Promise<V1ReceiverClaimRecord>;
  prepareClaimV1(
    id: string,
    body: { cycle?: number; allocationCid?: string; receiverClaimCid?: string },
  ): Promise<V1PreparedClaim>;
  recordClaimV1(id: string, body: V1RecordClaimParams): Promise<V1SettleResult>;
  prepareAcceptTransferV1(id: string, body: V1PendingSelector): Promise<V1PreparedInstructionAction>;
  recordAcceptTransferV1(id: string, body: V1RecordInstructionParams): Promise<V1SettleResult>;
  prepareWithdrawTransferV1(id: string, body: V1PendingSelector): Promise<V1PreparedInstructionAction>;
  recordWithdrawTransferV1(id: string, body: V1RecordInstructionParams): Promise<V1WithdrawResult>;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

/** Read the Amulet `amount` off a holding's create arguments. The canonical
 * Amulet record nests it as `amount.initialAmount` (a decimal string, e.g.
 * "9612.6154803099"); tolerate a flat string/number too. */
function holdingAmount(createArgs: Record<string, unknown>): number {
  const a = createArgs['amount'];
  if (a && typeof a === 'object') {
    const init = (a as Record<string, unknown>)['initialAmount'];
    if (init !== undefined) return Number(init);
  }
  if (typeof a === 'string' || typeof a === 'number') return Number(a);
  return 0;
}

/**
 * Locate the `createdEvent` inside one active-contracts entry. The hosted
 * wallet's `/v2/state/acs` returns the canonical Canton JSON Ledger-API shape —
 * `{ workflowId, contractEntry: { JsActiveContract: { createdEvent } } }` — so
 * we dig through that wrapper, with fallbacks for the flatter shapes other
 * adapters use. (The original decoder only checked a top-level `created_event`,
 * so it discarded every row — that was the "payer holds ≈0.0000" bug.)
 */
function findCreatedEvent(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const ce = asRecord(entry['contractEntry']);
  const active = ce ? asRecord(ce['JsActiveContract']) ?? ce : undefined;
  return (
    asRecord(active?.['createdEvent']) ??
    asRecord(active?.['created_event']) ??
    asRecord(entry['createdEvent']) ??
    asRecord(entry['created_event'])
  );
}

/** Decode one active-contracts entry into `{cid, amount}`, or null. The Amulet
 * record uses `createArgument` (singular) on the JSON Ledger API; tolerate the
 * plural / snake_case spellings other surfaces use. */
function decodeHolding(entry: Record<string, unknown>): Holding | null {
  const ev = findCreatedEvent(entry);
  if (!ev) return null;
  const cid = (ev['contractId'] ?? ev['contract_id']) as string | undefined;
  if (!cid) return null;
  const args =
    asRecord(ev['createArgument']) ??
    asRecord(ev['createArguments']) ??
    asRecord(ev['create_arguments']);
  return { cid, amount: args ? holdingAmount(args) : 0 };
}

/** Decode a holding read via the Holding INTERFACE (used for non-CC assets whose
 *  concrete template is unknown). Reads the standardized view's amount +
 *  instrumentId; returns null unless it's an unlocked holding of the wanted
 *  instrument with a spendable amount. */
function decodeInterfaceHolding(
  entry: Record<string, unknown>,
  wantInstrumentId: string,
  wantAdmin?: string,
): Holding | null {
  const ev = findCreatedEvent(entry);
  if (!ev) return null;
  const cid = (ev['contractId'] ?? ev['contract_id']) as string | undefined;
  if (!cid) return null;
  const views = (ev['interfaceViews'] ?? ev['interface_views']) as unknown[] | undefined;
  for (const v of views ?? []) {
    const vr = asRecord(v);
    const vv = asRecord(vr?.['viewValue'] ?? vr?.['view_value']);
    if (!vv) continue;
    const inst = asRecord(vv['instrumentId']);
    const id = inst ? String(inst['id'] ?? '') : String(vv['instrumentId'] ?? '');
    if (id !== wantInstrumentId) continue;
    if (wantAdmin && inst && inst['admin'] != null && String(inst['admin']) !== wantAdmin) continue;
    // A locked holding can't be spent as a transfer input.
    if (vv['lock'] != null) continue;
    const amt = Number(vv['amount']);
    if (Number.isFinite(amt) && amt > 0) return { cid, amount: amt };
  }
  return null;
}

/** Decode a holding read via a non-CC asset's concrete template (a wallet-safe
 *  template filter — Loop rejects interface filters). Returns null unless it's an
 *  unlocked holding the payer owns of the wanted instrument with a spendable
 *  amount — registrar-custody assets surface registrar-owned, locked holdings in
 *  the owner's ACS as an observer, and those aren't spendable inputs. */
function decodeConcreteHolding(
  entry: Record<string, unknown>,
  opts: { instrumentId?: string; admin?: string; owner?: string },
): Holding | null {
  const ev = findCreatedEvent(entry);
  if (!ev) return null;
  const cid = (ev['contractId'] ?? ev['contract_id']) as string | undefined;
  if (!cid) return null;
  const args =
    asRecord(ev['createArgument']) ??
    asRecord(ev['createArguments']) ??
    asRecord(ev['create_arguments']);
  if (!args) return null;
  // A locked holding can't be spent as a transfer input.
  if (args['lock'] != null) return null;
  // Only spend what the payer actually owns — the ACS also surfaces holdings the
  // payer merely observes (registrar-custodied), whose owner is the registrar.
  if (opts.owner && args['owner'] != null && String(args['owner']) !== opts.owner) return null;
  if (opts.instrumentId) {
    const inst = asRecord(args['instrument']) ?? asRecord(args['instrumentId']);
    const id = inst ? String(inst['id'] ?? '') : String(args['instrument'] ?? '');
    if (id && id !== opts.instrumentId) return null;
    if (opts.admin && inst && inst['admin'] != null && String(inst['admin']) !== opts.admin) return null;
  }
  const amount = holdingAmount(args);
  return amount > 0 ? { cid, amount } : null;
}

function decodeContract(entry: Record<string, unknown>): { cid: string; args: Record<string, unknown> } | null {
  const ev = findCreatedEvent(entry);
  if (!ev) return null;
  const cid = (ev['contractId'] ?? ev['contract_id']) as string | undefined;
  const args =
    asRecord(ev['createArgument']) ??
    asRecord(ev['createArguments']) ??
    asRecord(ev['create_arguments']);
  return cid && args ? { cid, args } : null;
}

function readSettlementRef(args: Record<string, unknown>): string | undefined {
  const allocation = asRecord(args['allocation']) ?? asRecord(args['spec']) ?? args;
  const settlement = asRecord(allocation['settlement']);
  const ref = asRecord(settlement?.['settlementRef']) ?? asRecord(settlement?.['settlement_ref']);
  const id = ref?.['id'];
  return typeof id === 'string' ? id : undefined;
}

async function discoverAllocationCid(party: string, ref: string): Promise<string> {
  const rows = await queryActiveContractsRaw([AMULET_ALLOCATION_TID], party);
  const match = rows
    .map((row) => decodeContract(row))
    .find((contract) => contract && readSettlementRef(contract.args) === ref);
  if (!match) {
    throw new Error(
      `Allocation was submitted but no active AmuletAllocation with settlement ref "${ref}" ` +
        `is visible in the wallet yet. Wait a few seconds and retry the record step.`,
    );
  }
  return match.cid;
}

async function discoverReceiverClaimCid(party: string, ref: string): Promise<string> {
  const rows = await queryActiveContractsRaw([RECEIVER_CLAIM_TID], party);
  const match = rows
    .map((row) => decodeContract(row))
    .find((contract) => contract?.args['expectedSettlementRef'] === ref);
  if (!match) {
    throw new Error(
      `ReceiverClaimV1 was submitted but no active claim with settlement ref "${ref}" ` +
        `is visible in the wallet yet. Wait a few seconds and retry the record step.`,
    );
  }
  return match.cid;
}

/**
 * Read the payer's spendable Canton Coin holdings as `{cid, amount}[]` from the
 * wallet's own participant (its `/v2/state/acs`). The proxy can't read these —
 * the payer lives on the wallet's participant, not BitDynamics — so model 2
 * supplies them. Each holding carries its real contract id (a transfer input)
 * and decimal amount (summed for the proxy's funding pre-check). Throws a clear,
 * actionable error when the wallet is empty or the rows can't be decoded.
 */
export async function readPayerHoldings(
  payerParty: string,
  opts?: { instrumentId?: string; instrumentAdmin?: string; holdingTemplateId?: string },
): Promise<Holding[]> {
  const wantId = opts?.instrumentId?.trim();
  // Non-CC asset (e.g. USDCx). Prefer the asset's concrete holding template via a
  // template filter — the only shape hosted wallets like Loop accept (they reject
  // interface filters). Fall back to the standardized Holding interface when the
  // concrete template isn't configured. CC keeps its concrete-template read below.
  if (wantId && wantId !== 'Amulet') {
    const tmpl = opts?.holdingTemplateId?.trim();
    const holdings = tmpl
      ? (await queryActiveContractsRaw([tmpl], payerParty))
          .map((r) =>
            decodeConcreteHolding(r, {
              instrumentId: wantId,
              admin: opts?.instrumentAdmin,
              owner: payerParty,
            }),
          )
          .filter((h): h is Holding => h !== null)
      : (await queryActiveContractsByInterfaceRaw([HOLDING_INTERFACE_ID], payerParty))
          .map((r) => decodeInterfaceHolding(r, wantId, opts?.instrumentAdmin))
          .filter((h): h is Holding => h !== null);
    if (holdings.length === 0) {
      throw new HoldingsEmptyError(
        `No spendable ${wantId} holdings found in your wallet. This wallet must OWN unlocked ` +
          `${wantId} (holdings you only receive-and-hold through a registrar's custody are not ` +
          `spendable). Fund it with ${wantId} you control, then try again.`,
      );
    }
    return holdings;
  }

  const rows = await queryActiveContractsRaw([AMULET_TID], payerParty);
  const holdings = rows
    .map(decodeHolding)
    .filter((h): h is Holding => h !== null && h.amount > 0);

  if (holdings.length === 0) {
    if (rows.length === 0) {
      throw new HoldingsEmptyError(
        'No Canton Coin holdings found in your wallet. Fund your Loop wallet with CC, ' +
          'then press Settle again — V1 draws each cycle live from your wallet.',
      );
    }
    const sample = Object.keys(rows[0] ?? {}).join(', ');
    throw new Error(
      `Found ${rows.length} holding record(s) but couldn't read a spendable amount/id from them ` +
        `(row keys: ${sample}). This is a wallet-API shape issue, not a funding problem.`,
    );
  }
  return holdings;
}

// Keys that carry a REAL on-ledger reference. Deliberately excludes commandId
// (that's our own dashboard-generated id, not proof of a commit). Loop returns
// snake_case `update_id`, often nested under `payload`.
const UPDATE_ID_KEYS = ['updateId', 'update_id', 'transactionId', 'transaction_id'] as const;
const NEST_KEYS = ['payload', 'transaction', 'transactionTree', 'completion', 'result', 'data', 'response'] as const;

/** A value that looks like a genuine Canton update/transaction id — a long
 * hex-ish string, not our `dashboard-…` commandId nor the old placeholder. */
function looksLikeLedgerId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length >= 16 &&
    v !== 'wallet-submitted' &&
    !v.startsWith('dashboard-') &&
    /^[0-9a-fA-F:_-]+$/.test(v)
  );
}

/** Find a real on-ledger update id anywhere in the wallet's response, or
 * undefined if there is none (i.e. the submit did NOT demonstrably commit). */
export function extractUpdateId(res: unknown, depth = 0): string | undefined {
  if (!res || typeof res !== 'object' || depth > 4) return undefined;
  const r = res as Record<string, unknown>;
  for (const k of UPDATE_ID_KEYS) {
    if (looksLikeLedgerId(r[k])) return r[k] as string;
  }
  for (const nk of NEST_KEYS) {
    const found = extractUpdateId(r[nk], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Detect an explicit failure the wallet reported WITHOUT throwing (Loop can
 * resolve `run_transaction` with an `{ error_message }` / `{ status: "failed" }`
 * body). Returns the human message, or undefined when no failure is signalled. */
export function walletSubmitError(res: unknown, depth = 0): string | undefined {
  if (!res || typeof res !== 'object' || depth > 4) return undefined;
  const r = res as Record<string, any>;
  const em =
    r['error_message'] ??
    r['errorMessage'] ??
    (typeof r['error'] === 'string' ? r['error'] : r['error']?.message);
  if (typeof em === 'string' && em.length > 0) return em;
  const st = r['status'];
  if (typeof st === 'string' && /fail|error|reject|abort|deni/i.test(st)) return `status=${st}`;
  for (const nk of ['payload', 'result', 'data', 'response', 'completion'] as const) {
    const f = walletSubmitError(r[nk], depth + 1);
    if (f) return f;
  }
  return undefined;
}

/** A created event decoded out of a committed update tree: its template id, flat
 *  create arguments, and any standardized interface views. */
interface CreatedNode {
  templateId: string;
  args?: Record<string, unknown>;
  views: Record<string, unknown>[];
}

/** Walk a committed update (from `fetchUpdateById`) and collect every node that
 *  looks like a created event — one carrying a templateId plus create arguments
 *  or interface views. Shape-tolerant (LEDGER_EFFECTS events, flat `createdEvent`
 *  wrappers, snake/camel spellings) so it works across wallet passthroughs. */
function collectCreatedNodes(root: unknown): CreatedNode[] {
  const out: CreatedNode[] = [];
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    const obj = node as Record<string, unknown>;
    const tid = obj['templateId'] ?? obj['template_id'];
    const args =
      asRecord(obj['createArgument']) ??
      asRecord(obj['createArguments']) ??
      asRecord(obj['create_arguments']);
    const rawViews = (obj['interfaceViews'] ?? obj['interface_views']) as unknown[] | undefined;
    const views = Array.isArray(rawViews)
      ? rawViews.map((v) => asRecord(v)).filter((v): v is Record<string, unknown> => v !== undefined)
      : [];
    if (typeof tid === 'string' && (args || views.length > 0)) {
      out.push({ templateId: tid, args, views });
    }
    for (const v of Object.values(obj)) stack.push(v);
  }
  return out;
}

/** Read an `{ id, admin }` instrument off a holding's args or a transfer record,
 *  tolerating both the nested-record and flat-string spellings. */
function readInstrumentId(src: Record<string, unknown>): { id?: string; admin?: string } {
  const inst = asRecord(src['instrument']) ?? asRecord(src['instrumentId']);
  if (inst) {
    return {
      id: inst['id'] != null ? String(inst['id']) : undefined,
      admin: inst['admin'] != null ? String(inst['admin']) : undefined,
    };
  }
  const flat = src['instrument'] ?? src['instrumentId'];
  return { id: typeof flat === 'string' ? flat : undefined };
}

/** Read a holding's amount as a raw decimal string (preserving precision). The
 *  utility-registry holding carries a flat decimal; Amulet nests it under
 *  `amount.initialAmount`. */
function rawHoldingAmount(args: Record<string, unknown>): string | undefined {
  const a = args['amount'];
  if (a && typeof a === 'object') {
    const init = (a as Record<string, unknown>)['initialAmount'];
    if (init != null) return String(init);
  }
  if (typeof a === 'string') return a;
  if (typeof a === 'number') return String(a);
  return undefined;
}

/**
 * Build a wallet-side proof-of-transfer for a non-CC direct settle by walking
 * the committed update the payer's wallet just submitted. Prefers a created
 * Holding of the asset OWNED BY the recipient (a completed direct delivery);
 * falls back to a created TransferOffer to the recipient (a pending offer read
 * from its transfer-instruction-v1 interface view). Returns undefined when
 * neither is found, so the caller omits the proof and the proxy falls back to
 * its interim trust path rather than hard-failing the settle.
 */
export function extractTransferProof(
  update: unknown,
  opts: { payerParty: string; recipientParty?: string; instrumentId: string; instrumentAdmin?: string },
): V1TransferProof | undefined {
  const nodes = collectCreatedNodes(update);
  const wantOwner = (owner: string): boolean =>
    opts.recipientParty ? owner === opts.recipientParty : owner !== opts.payerParty;

  // 1. A created Holding owned by the recipient = a completed direct delivery.
  for (const n of nodes) {
    if (!n.args) continue;
    const owner = n.args['owner'];
    if (typeof owner !== 'string' || !wantOwner(owner)) continue;
    const inst = readInstrumentId(n.args);
    if (inst.id && inst.id !== opts.instrumentId) continue;
    if (opts.instrumentAdmin && inst.admin && inst.admin !== opts.instrumentAdmin) continue;
    const amount = rawHoldingAmount(n.args);
    if (!amount || !(Number(amount) > 0)) continue;
    const admin = inst.admin ?? opts.instrumentAdmin;
    return {
      receiver: owner,
      amount,
      instrumentId: inst.id ?? opts.instrumentId,
      ...(admin ? { instrumentAdmin: admin } : {}),
      delivered: true,
    };
  }

  // 2. A created TransferOffer to the recipient = a pending offer (not delivered).
  for (const n of nodes) {
    const transfers: Record<string, unknown>[] = [];
    const argTransfer = n.args ? asRecord(n.args['transfer']) : undefined;
    if (argTransfer) transfers.push(argTransfer);
    for (const v of n.views) {
      const vv = asRecord(v['viewValue'] ?? v['view_value']);
      const t = vv ? asRecord(vv['transfer']) : undefined;
      if (t) transfers.push(t);
    }
    for (const t of transfers) {
      const receiver = t['receiver'];
      if (typeof receiver !== 'string' || !wantOwner(receiver)) continue;
      const inst = readInstrumentId(t);
      if (inst.id && inst.id !== opts.instrumentId) continue;
      if (opts.instrumentAdmin && inst.admin && inst.admin !== opts.instrumentAdmin) continue;
      const amt = t['amount'];
      const amount = typeof amt === 'string' ? amt : amt != null ? String(amt) : undefined;
      if (!amount || !(Number(amount) > 0)) continue;
      const sender = t['sender'];
      const admin = inst.admin ?? opts.instrumentAdmin;
      return {
        ...(typeof sender === 'string' ? { sender } : {}),
        receiver,
        amount,
        instrumentId: inst.id ?? opts.instrumentId,
        ...(admin ? { instrumentAdmin: admin } : {}),
        delivered: false,
      };
    }
  }
  return undefined;
}

export async function settleV1ViaWallet(
  client: V1WalletSettleClient,
  id: string,
  payerParty: string,
  opts: {
    force?: boolean;
    amount?: string;
    assetInstrumentId?: string;
    assetInstrumentAdmin?: string;
    assetHoldingTemplateId?: string;
    /** The stream recipient — lets a non-CC settle bind its proof-of-transfer to
     *  the delivery holding/offer that lands on the recipient. */
    recipientParty?: string;
  } = {},
): Promise<V1SettleResult> {
  // 1. Read the payer's spendable holdings of this stream's asset from its own
  //    participant — CC by default; a non-CC stream (e.g. USDCx) supplies its
  //    instrument so the right holdings are drawn, not Amulet. Throws a clear,
  //    actionable error when the wallet is empty or the records can't be read.
  const holdings = await readPayerHoldings(payerParty, {
    ...(opts.assetInstrumentId ? { instrumentId: opts.assetInstrumentId } : {}),
    ...(opts.assetInstrumentAdmin ? { instrumentAdmin: opts.assetInstrumentAdmin } : {}),
    ...(opts.assetHoldingTemplateId ? { holdingTemplateId: opts.assetHoldingTemplateId } : {}),
  });

  // 2. Proxy forms the transfer (registry choice-context; whitelisted egress).
  const prepared = await client.prepareSettleV1(id, {
    force: opts.force,
    amount: opts.amount,
    holdings,
  });
  if (!prepared.prepared) {
    return { settled: false, reason: prepared.reason ?? 'nothing_due' };
  }

  // Self-heal: Loop sometimes throws/returns a rejection AFTER the transfer has
  // actually committed on-ledger. So whenever the submit looks like it failed,
  // ask the proxy to recover any offer that genuinely landed; only if nothing
  // landed do we surface the failure. This stops a committed-but-unreported
  // settle from leaving the CC locked with no record to Accept against.
  const recoverIfCommitted = async (): Promise<V1SettleResult | null> => {
    const rec = await client.recoverPendingV1(id).catch(() => ({ recovered: [] as V1PendingTransferRecord[] }));
    const offer = rec.recovered[0];
    return offer ? { settled: false, reason: 'pending_acceptance', pending: offer } : null;
  };

  // Before the wallet signs, make the proxy prove it prepared a transfer FROM the
  // connected payer — the signer must be the payer, not some other party the
  // proxy substituted. Mirrors the accept/withdraw/claim guards below. (Binding
  // the receiver and amount too would need the recipient threaded into this call;
  // until then the wallet popup remains the receiver/amount gate.)
  if (prepared.actAs !== payerParty) {
    throw new Error(
      `Prepared settle must be signed by ${payerParty}, but the proxy prepared it for ${prepared.actAs}.`,
    );
  }

  // 3. The payer's WALLET signs + submits through its own participant.
  let res: unknown;
  try {
    res = await submitAndWait([prepared.command!], prepared.actAs, {
      disclosedContracts: prepared.disclosedContracts,
    });
  } catch (submitErr) {
    const recovered = await recoverIfCommitted();
    if (recovered) return recovered;
    throw submitErr;
  }

  // 3a. Verify the submit actually committed BEFORE recording anything. Loop can
  //     resolve with an error body (no throw) or with a success body whose update
  //     id we must capture. Recording a cycle without a real on-ledger id would be
  //     a phantom settle — fail closed (after the on-ledger recovery check).
  const failure = walletSubmitError(res);
  if (failure) {
    const recovered = await recoverIfCommitted();
    if (recovered) return recovered;
    throw new Error(
      `The wallet did not commit the transfer: ${failure}. Nothing was recorded — your CC was not moved.`,
    );
  }
  const updateId = extractUpdateId(res);
  if (!updateId) {
    const recovered = await recoverIfCommitted();
    if (recovered) return recovered;
    const keys =
      res && typeof res === 'object'
        ? Object.keys(res as Record<string, unknown>).join(', ')
        : String(res);
    throw new Error(
      `The wallet returned no on-ledger transaction id, so the settle is NOT confirmed on chain ` +
        `(response keys: ${keys}). Nothing was recorded. If the Loop popup never asked you to ` +
        `approve a transfer, it was not submitted — try again and approve the signature prompt.`,
    );
  }

  // 4a. Non-CC direct settle: the payer's own participant can witness the update
  //     it just submitted (the proxy can't). Fetch it and extract a validated
  //     transfer object so the proxy credits proof, not blind trust. Best-effort —
  //     if it can't be fetched/parsed, omit the proof and let the proxy fall back
  //     to its interim path rather than failing the settle. CC is unchanged.
  let transferProof: V1TransferProof | undefined;
  if (opts.assetInstrumentId && opts.assetInstrumentId !== 'Amulet') {
    const update = await fetchUpdateById(updateId).catch(() => null);
    if (update) {
      transferProof = extractTransferProof(update, {
        payerParty,
        ...(opts.recipientParty ? { recipientParty: opts.recipientParty } : {}),
        instrumentId: opts.assetInstrumentId,
        ...(opts.assetInstrumentAdmin ? { instrumentAdmin: opts.assetInstrumentAdmin } : {}),
      });
    }
  }

  // 4b. Record the committed cycle, now backed by a real ledger update id
  //    (idempotent on updateId). The proxy classifies the on-chain outcome from
  //    the Scan update: a transfer that landed as a pending offer (recipient has
  //    no pre-approval) comes back as `{ settled: false, pending }` — the
  //    recipient must accept it; only a direct delivery is recorded as settled.
  return client.recordSettleV1(id, {
    updateId,
    amount: prepared.amount!,
    ref: prepared.ref,
    executeBefore: prepared.executeBefore,
    ...(transferProof ? { transferProof } : {}),
  });
}

/**
 * Receiver-side accept of a pending transfer offer:
 *   1. Proxy fetches the live TransferInstruction_Accept choice-context.
 *   2. Bob signs `TransferInstruction_Accept` through his wallet.
 *   3. Proxy records the delivered cycle only after Scan confirms the update id.
 * No custom DAR — this is pure Splice transfer-instruction-v1.
 */
export async function acceptTransferV1ViaWallet(
  client: V1WalletSettleClient,
  id: string,
  recipientParty: string,
  selector: V1PendingSelector = {},
): Promise<V1SettleResult> {
  const prepared = await client.prepareAcceptTransferV1(id, selector);
  if (!prepared.prepared) {
    return { settled: false, reason: prepared.reason ?? 'no_pending_offer' };
  }
  if (prepared.actAs !== recipientParty) {
    throw new Error(
      `Prepared accept must be signed by ${prepared.actAs}, but the connected wallet is ${recipientParty}.`,
    );
  }
  const res = await submitAndWait([prepared.command!], prepared.actAs, {
    disclosedContracts: prepared.disclosedContracts as Record<string, unknown>[] | undefined,
  });
  const failure = walletSubmitError(res);
  if (failure) {
    throw new Error(`The wallet did not commit the acceptance: ${failure}. Nothing was recorded.`);
  }
  const updateId = extractUpdateId(res);
  if (!updateId) {
    throw new Error(
      'The wallet returned no on-ledger transaction id for the acceptance, so the proxy cannot ' +
        'safely record it. If the wallet popup did not approve the transfer, nothing moved.',
    );
  }
  return client.recordAcceptTransferV1(id, {
    updateId,
    transferInstructionCid: prepared.transferInstructionCid,
    cycle: prepared.cycle,
  });
}

/**
 * Sender-side withdraw (retry) of a pending offer the recipient never accepted:
 *   1. Proxy fetches the live TransferInstruction_Withdraw choice-context.
 *   2. Alice signs `TransferInstruction_Withdraw` through her wallet.
 *   3. Proxy records the reclaim only after Scan confirms the update id.
 * The locked CC returns to Alice; she can then settle the cycle again.
 */
export async function withdrawTransferV1ViaWallet(
  client: V1WalletSettleClient,
  id: string,
  payerParty: string,
  selector: V1PendingSelector = {},
): Promise<V1WithdrawResult> {
  const prepared = await client.prepareWithdrawTransferV1(id, selector);
  if (!prepared.prepared) {
    return { withdrawn: false, reason: prepared.reason ?? 'no_pending_offer' };
  }
  if (prepared.actAs !== payerParty) {
    throw new Error(
      `Prepared withdraw must be signed by ${prepared.actAs}, but the connected wallet is ${payerParty}.`,
    );
  }
  const res = await submitAndWait([prepared.command!], prepared.actAs, {
    disclosedContracts: prepared.disclosedContracts as Record<string, unknown>[] | undefined,
  });
  const failure = walletSubmitError(res);
  if (failure) {
    throw new Error(`The wallet did not commit the withdrawal: ${failure}. Nothing was recorded.`);
  }
  const updateId = extractUpdateId(res);
  if (!updateId) {
    throw new Error(
      'The wallet returned no on-ledger transaction id for the withdrawal, so the proxy cannot ' +
        'safely record it. If the wallet popup did not approve it, the offer is unchanged.',
    );
  }
  return client.recordWithdrawTransferV1(id, {
    updateId,
    transferInstructionCid: prepared.transferInstructionCid,
    cycle: prepared.cycle,
  });
}

/**
 * Sender-side receiver-claim setup:
 *   1. Alice signs AllocationFactory_Allocate to lock one cycle.
 *   2. The dashboard discovers the allocation cid from Alice's wallet ACS.
 *   3. Alice signs ReceiverClaimV1 create, capturing her one-time consent.
 *   4. The dashboard discovers and records the ReceiverClaimV1 cid.
 *
 * After this completes, Bob sees a claim-ready record and can run
 * `claimV1ViaWallet` after `unlockAt`.
 */
export async function fundReceiverClaimV1ViaWallet(
  client: V1WalletSettleClient,
  id: string,
  payerParty: string,
  opts: { force?: boolean; amount?: string; unlockAt?: string; expiresAt?: string } = {},
): Promise<V1ReceiverClaimRecord | { funded: false; reason: string }> {
  const holdings = await readPayerHoldings(payerParty);
  const allocation = await client.prepareAllocationV1(id, {
    force: opts.force,
    amount: opts.amount,
    holdings,
    unlockAt: opts.unlockAt,
    expiresAt: opts.expiresAt,
  });
  if (!allocation.prepared) {
    return { funded: false, reason: allocation.reason ?? 'nothing_due' };
  }

  const allocateResult = await submitAndWait([allocation.command!], allocation.actAs!, {
    disclosedContracts: allocation.disclosedContracts,
  });
  const allocateFailure = walletSubmitError(allocateResult);
  if (allocateFailure) {
    throw new Error(`The wallet did not create the allocation: ${allocateFailure}.`);
  }
  const allocationUpdateId = extractUpdateId(allocateResult);
  const allocationCid = await discoverAllocationCid(payerParty, allocation.ref!);

  await client.recordAllocationV1(id, {
    allocationCid,
    allocationUpdateId,
    amount: allocation.amount!,
    ref: allocation.ref,
    cycle: allocation.cycle!,
    executor: allocation.executor,
    unlockAt: allocation.unlockAt!,
    expiresAt: allocation.expiresAt!,
  });

  const claim = await client.prepareReceiverClaimV1(id, {
    cycle: allocation.cycle!,
    allocationCid,
  });
  const claimCreateResult = await submitAndWait([claim.command], claim.actAs, {
    disclosedContracts: claim.disclosedContracts,
  });
  const claimCreateFailure = walletSubmitError(claimCreateResult);
  if (claimCreateFailure) {
    throw new Error(`The wallet did not create the receiver claim: ${claimCreateFailure}.`);
  }
  const receiverClaimCid = await discoverReceiverClaimCid(payerParty, claim.ref);
  return client.recordReceiverClaimV1(id, {
    receiverClaimCid,
    cycle: claim.cycle,
    allocationCid,
  });
}

/**
 * Receiver-side claim:
 *   1. Proxy fetches the live execute-transfer choice-context + disclosures.
 *   2. Bob signs ReceiverClaimV1.Claim through his wallet.
 *   3. Proxy records only after Scan confirms the update id.
 */
export async function claimV1ViaWallet(
  client: V1WalletSettleClient,
  id: string,
  recipientParty: string,
  selector: { cycle?: number; allocationCid?: string; receiverClaimCid?: string } = {},
): Promise<V1SettleResult> {
  const prepared = await client.prepareClaimV1(id, selector);
  if (!prepared.prepared) {
    return { settled: false, reason: prepared.reason ?? 'no_claim_ready' };
  }
  if (prepared.actAs !== recipientParty) {
    throw new Error(
      `Prepared claim must be signed by ${prepared.actAs}, but the connected wallet is ${recipientParty}.`,
    );
  }
  const res = await submitAndWait([prepared.command!], prepared.actAs, {
    disclosedContracts: prepared.disclosedContracts,
  });
  const failure = walletSubmitError(res);
  if (failure) {
    throw new Error(`The wallet did not commit the claim: ${failure}. Nothing was recorded.`);
  }
  const updateId = extractUpdateId(res);
  if (!updateId) {
    throw new Error(
      'The wallet returned no on-ledger transaction id for the claim, so the proxy cannot ' +
        'safely record it. If the wallet popup did not approve a claim, nothing moved.',
    );
  }
  return client.recordClaimV1(id, {
    updateId,
    cycle: prepared.cycle,
    allocationCid: prepared.allocationCid,
    receiverClaimCid: prepared.receiverClaimCid,
  });
}
