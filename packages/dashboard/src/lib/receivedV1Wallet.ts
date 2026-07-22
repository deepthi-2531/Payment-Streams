/**
 * Incoming view + accept for a wallet party that is NOT hosted on the proxy's
 * participant (e.g. a Loop party). Such a party's incoming
 * AmuletTransferInstructions and delivered Amulets are only witnessed by ITS
 * OWN participant, so the proxy's `/api/v1/received` sees nothing for it — we
 * read them via the connected wallet's CIP-0103 `ledgerApi` instead. Accept
 * still uses the proxy to build the registry choice-context (whitelisted
 * egress), then the wallet signs and submits on its own participant.
 */
import { queryActiveContracts, submitAndWait } from './hostedWalletLedger.js';
import type {
  CantonStreamsApi,
  V1ReceivedView,
  V1ReceivedPendingOffer,
  V1ReceivedAcceptResult,
} from '../api/client.js';

const AMULET_TRANSFER_INSTRUCTION_TID =
  '#splice-amulet:Splice.AmuletTransferInstruction:AmuletTransferInstruction';

/** Deep-search a wallet response for the first string value under any of `keys`,
 *  rejecting the known placeholders so we never treat a non-committed submit as
 *  real. */
function deepFind(res: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (!res || typeof res !== 'object' || depth > 6) return undefined;
  const r = res as Record<string, unknown>;
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string' && v && !v.startsWith('dashboard-') && v !== 'wallet-submitted') {
      return v;
    }
  }
  for (const nk of Object.keys(r)) {
    const f = deepFind(r[nk], keys, depth + 1);
    if (f) return f;
  }
  return undefined;
}

/** Pending incoming offers for a wallet party, read from the wallet's own ACS. */
export async function listReceivedViaWallet(party: string): Promise<V1ReceivedView> {
  const nowMs = Date.now();
  const offers = await queryActiveContracts([AMULET_TRANSFER_INSTRUCTION_TID], party);
  const pending: V1ReceivedPendingOffer[] = offers
    .map((c) => ({ c, tr: (c.createArguments['transfer'] ?? {}) as Record<string, unknown> }))
    .filter(({ tr }) => tr['receiver'] === party)
    .map(({ c, tr }) => {
      const instr = tr['instrumentId'];
      const executeBefore = (tr['executeBefore'] as string | undefined) ?? undefined;
      return {
        transferInstructionCid: c.contractId,
        amount: String(tr['amount'] ?? '0'),
        sender: String(tr['sender'] ?? ''),
        instrumentId:
          instr && typeof instr === 'object'
            ? String((instr as Record<string, unknown>)['id'] ?? 'Amulet')
            : String(instr ?? 'Amulet'),
        requestedAt: (tr['requestedAt'] as string | undefined) ?? undefined,
        executeBefore,
        expired: !!executeBefore && Date.parse(executeBefore) < nowMs,
      };
    });
  // A wallet party's delivered-transfer history isn't exposed through the
  // CIP-0103 surface, so `received` is left to the wallet's own balance view;
  // the actionable incoming (pending offers) is what the Inbox surfaces here.
  return { party, pending, received: [] };
}

/** Accept a pending incoming offer with the connected wallet: the proxy builds
 *  the TransferInstruction_Accept command + disclosures, the wallet signs and
 *  submits it. */
export async function acceptReceivedViaWallet(
  client: Pick<CantonStreamsApi, 'prepareAcceptReceivedV1'>,
  party: string,
  transferInstructionCid: string,
): Promise<V1ReceivedAcceptResult> {
  const prepared = await client.prepareAcceptReceivedV1(transferInstructionCid);
  if (prepared.actAs !== party) {
    throw new Error(
      `Prepared accept must be signed by ${prepared.actAs}, but the connected wallet is ${party}.`,
    );
  }
  const res = await submitAndWait([prepared.command as Record<string, unknown>], party, {
    disclosedContracts: prepared.disclosedContracts as Record<string, unknown>[] | undefined,
  });
  const failure = deepFind(res, ['error_message', 'errorMessage']);
  if (failure) {
    throw new Error(`The wallet did not commit the acceptance: ${failure}. Nothing moved.`);
  }
  const updateId = deepFind(res, ['updateId', 'update_id', 'transactionId', 'transaction_id']);
  if (!updateId) {
    throw new Error(
      'The wallet returned no on-ledger transaction id for the acceptance. If the wallet popup ' +
        'did not approve the transfer, nothing moved.',
    );
  }
  return { updateId, amount: '0', sender: '' };
}
