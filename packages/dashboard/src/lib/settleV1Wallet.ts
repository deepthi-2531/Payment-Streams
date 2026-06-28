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

import { queryActiveContractsRaw, submitAndWait } from './hostedWalletLedger.js';
import type {
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
async function readPayerHoldings(payerParty: string): Promise<Holding[]> {
  const rows = await queryActiveContractsRaw([AMULET_TID], payerParty);
  const holdings = rows
    .map(decodeHolding)
    .filter((h): h is Holding => h !== null && h.amount > 0);

  if (holdings.length === 0) {
    if (rows.length === 0) {
      throw new Error(
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
function extractUpdateId(res: unknown, depth = 0): string | undefined {
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
function walletSubmitError(res: unknown, depth = 0): string | undefined {
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

export async function settleV1ViaWallet(
  client: V1WalletSettleClient,
  id: string,
  payerParty: string,
  opts: { force?: boolean; amount?: string } = {},
): Promise<V1SettleResult> {
  // 1. The payer's spendable Canton Coin holdings live on its own participant.
  //    For Loop this reads the balance from Loop's REST API and the input cids
  //    from its active-contracts rows; throws a clear, actionable error when the
  //    wallet is empty or the holding records can't be read.
  const holdings = await readPayerHoldings(payerParty);

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

  // 3. The payer's WALLET signs + submits through its own participant.
  let res: unknown;
  try {
    res = await submitAndWait([prepared.command!], prepared.actAs!, {
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

  // 4. Record the committed cycle, now backed by a real ledger update id
  //    (idempotent on updateId). The proxy classifies the on-chain outcome from
  //    the Scan update: a transfer that landed as a pending offer (recipient has
  //    no pre-approval) comes back as `{ settled: false, pending }` — the
  //    recipient must accept it; only a direct delivery is recorded as settled.
  return client.recordSettleV1(id, {
    updateId,
    amount: prepared.amount!,
    ref: prepared.ref,
    executeBefore: prepared.executeBefore,
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
