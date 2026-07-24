/**
 * Model 2 — wallet-signed escrow deposit.
 *
 * The operator-custodied stream's whole point is the payer signs ONCE. When the
 * payer's key is held by a hosted wallet (Loop/PartyLayer), that one deposit
 * must be signed through the WALLET'S participant, not the proxy. Flow:
 *   1. read the payer's spendable Canton Coin holdings from its own participant;
 *   2. ask the proxy to FORM the payer→escrow TransferFactory_Transfer (registry
 *      choice-context; needs the validator's whitelisted egress);
 *   3. the payer's wallet submits it (one approval popup), signing with its key;
 *   4. record the escrow with the resulting on-ledger updateId as the funding
 *      receipt — the streamer then releases to the payee with no further signing.
 *
 * The escrow party holds a TransferPreapproval, so the deposit lands directly.
 */

import { submitAndWait } from './hostedWalletLedger.js';
import { readPayerHoldings, extractUpdateId, walletSubmitError } from './settleV1Wallet.js';
import type { CreateEscrowParams, EscrowPreparedDeposit, EscrowView } from '../api/client.js';

/** The proxy calls this orchestrator needs from the API client. */
export interface EscrowWalletClient {
  escrowInfo(): Promise<{ readonly escrowParty: string }>;
  prepareEscrowDeposit(body: {
    payerParty?: string;
    totalDeposit: string;
    holdings?: { cid: string; amount: number }[];
    assetKey?: string;
  }): Promise<EscrowPreparedDeposit>;
  createEscrow(params: CreateEscrowParams): Promise<EscrowView>;
}

/**
 * Fund + create an operator-custodied stream where the payer is a wallet party.
 * Throws a clear, actionable error (and records nothing) unless the deposit
 * demonstrably committed on-ledger — no phantom escrow.
 */
export async function createEscrowViaWallet(
  client: EscrowWalletClient,
  params: CreateEscrowParams & { payerParty: string },
): Promise<EscrowView> {
  // 1. Read the payer's spendable CC from its own participant.
  const holdings = await readPayerHoldings(params.payerParty);

  // 2. Proxy forms the payer→escrow deposit transfer.
  const prepared = await client.prepareEscrowDeposit({
    payerParty: params.payerParty,
    totalDeposit: params.totalDeposit,
    holdings,
    ...(params.assetKey ? { assetKey: params.assetKey } : {}),
  });

  // Don't blind-sign the proxy-formed command: verify it acts as the payer and
  // targets the escrow party, so a mis-formed command can't send the funds
  // elsewhere. The exact amount is bound on-chain by the proxy's deposit checks.
  if (!prepared.actAs?.includes(params.payerParty)) {
    throw new Error(
      'Refusing to sign: the deposit is not authorized as your wallet. No escrow was created.',
    );
  }
  const { escrowParty } = await client.escrowInfo();
  if (!JSON.stringify(prepared.command ?? {}).includes(escrowParty)) {
    throw new Error(
      'Refusing to sign: the deposit does not target the escrow custody party. No escrow was created.',
    );
  }

  // 3. The payer's wallet signs + submits it through its own participant.
  const res = await submitAndWait([prepared.command as Record<string, unknown>], prepared.actAs, {
    disclosedContracts: prepared.disclosedContracts as Record<string, unknown>[] | undefined,
  });

  const failure = walletSubmitError(res);
  if (failure) {
    throw new Error(`The wallet did not commit the deposit: ${failure}. No escrow was created.`);
  }
  const fundingTransferId = extractUpdateId(res);
  if (!fundingTransferId) {
    throw new Error(
      'The wallet returned no on-ledger transaction id for the deposit, so the escrow was NOT ' +
        'created. If the wallet popup never asked you to approve a transfer, it was not submitted — ' +
        'try again and approve the signature prompt.',
    );
  }

  // 4. Record the escrow against the committed deposit; the streamer takes over.
  return client.createEscrow({ ...params, fundingTransferId });
}
