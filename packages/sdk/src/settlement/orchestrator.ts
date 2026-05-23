/**
 * @module settlement/orchestrator
 *
 * SettlementOrchestrator — coordinates token transfer execution + Daml state updates
 * for TokenStandardCustody streams.
 *
 * For each stream lifecycle action, the orchestrator:
 *   1. Loads the current stream / request state from the ledger
 *   2. Computes the amounts involved (using the same accrual math as Daml)
 *   3. Picks the right SettlementAdapter (TransferRule, TransferOffer, etc.)
 *   4. Executes the token transfer(s) via the adapter
 *   5. Calls the appropriate Daml choice with the resulting settlement references
 *
 * This is the "one-click" layer: proxy routes hit the orchestrator and the user
 * never has to manually supply settlement references.
 *
 * Actions handled:
 *   - finalize  : sender → escrow transfer, then FinalizeTokenStandardEscrow
 *   - withdraw  : escrow → recipient transfer, then Withdraw_TokenStandard
 *   - cancel    : escrow → recipient + escrow → sender, then Cancel_TokenStandard
 *   - renew     : sender → escrow top-up, then Renew_TokenStandard
 */

import type { Logger } from 'pino';
import type { Transport } from '../transport/base.js';
import type { SettlementAdapter, TransferResult } from './adapter.js';
import { AmuletWalletGatewayAdapter } from './adapters/amulet.js';
import { TransferOfferAdapter } from './adapters/transfer-offer.js';
import { TransferRuleAdapter } from './adapters/transfer-rule.js';
import {
  readHostedWalletCredentialMapFromEnv,
  signPreparedHash,
  trimToUndefined,
} from './adapters/hosted-wallet.js';
import type { WithdrawResult, CancelResult, RenewParams } from '../types/stream.js';
import { SettlementMode, StreamStatus } from '../types/stream.js';
import { getBalances } from '../accrual/calculator.js';
import { getStream } from '../commands/query.js';
import Decimal from 'decimal.js';
import {
  TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST,
  TEMPLATE_TOKEN_STANDARD_ESCROW,
  CHOICE_FINALIZE_TOKEN_STANDARD_ESCROW,
  CHOICE_WITHDRAW_TOKEN_STANDARD,
  CHOICE_CANCEL_TOKEN_STANDARD,
  CHOICE_MUTUAL_CANCEL_TOKEN_STANDARD,
  CHOICE_RENEW_TOKEN_STANDARD,
  assertTokenStandardEscrowAvailable,
} from '../templates.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface OrchestratedFinalizeResult {
  readonly escrowContractId: string;
  readonly settlementReference: string;
  readonly escrowReference: string;
  readonly confirmedEscrowAmount: Decimal;
}

export interface OrchestratedWithdrawResult extends WithdrawResult {
  readonly settlementReference: string;
}

export interface OrchestratedCancelResult extends CancelResult {
  readonly recipientSettlementReference?: string;
  readonly senderRefundReference?: string;
}

export interface OrchestratedRenewResult {
  readonly contractId: string;
  readonly settlementReference: string;
  readonly confirmedAdditionalAmount: Decimal;
}

// ---------------------------------------------------------------------------
// SettlementOrchestrator
// ---------------------------------------------------------------------------

export class SettlementOrchestrator {
  constructor(private readonly adapters: SettlementAdapter[]) {}

  // ---------------------------------------------------------------------------
  // finalize
  // ---------------------------------------------------------------------------

  /**
   * Execute the sender → escrow transfer, then finalize the stream on-ledger.
   *
   * Requires:
   *   - An AcceptedTokenStandardStreamRequest on the ledger for (sender, streamId)
   *   - actAs must include: sender, escrowOperator
   */
  async finalize(
    transport: Transport,
    sender: string,
    streamId: string,
    escrowParty: string,
    actAs: string[],
    logger: Logger,
    acceptedRequestContractId?: string,
  ): Promise<OrchestratedFinalizeResult> {
    // [C1 fix — STR-103] Daml TokenStandardEscrow + workflow modules missing.
    // Fail closed before any ledger submission to avoid an opaque "template
    // not found" error from the participant.
    assertTokenStandardEscrowAvailable();
    logger.info({ sender, streamId }, 'Orchestrator: finalizing TokenStandard stream');

    // Load the accepted request
    const { contractId, depositAmount, config } = await this.loadAcceptedRequest(
      transport, sender, streamId, actAs, logger, acceptedRequestContractId,
    );

    const registrar = config.instrumentRef?.issuer ?? '';
    const instrumentId = config.instrumentRef?.instrumentId ?? '';
    if (!registrar || !instrumentId) {
      throw new Error(
        `Stream ${streamId} has no instrumentRef — cannot determine settlement adapter.`,
      );
    }

    // Execute sender → escrow transfer
    const adapter = await this.selectAdapter(registrar, instrumentId);
    const transferResult = await adapter.transfer(
      {
        from: sender,
        to: escrowParty,
        amount: depositAmount,
        registrar,
        instrumentId,
        reference: `finalize-${streamId}`,
      },
      actAs,
      transport,
      logger,
    );

    // Finalize on-ledger
    const finalizeArgs = {
      escrowReference: { text: escrowParty },
      settlementReference: { text: transferResult.settlementReference },
      confirmedEscrowAmount: { numeric: depositAmount.toFixed(10) },
    };

    let result: any;
    try {
      result = await transport.exercise<any>(
        TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST,
        contractId,
        CHOICE_FINALIZE_TOKEN_STANDARD_ESCROW,
        finalizeArgs,
        actAs,
      );
    } catch (error) {
      if (!shouldUseInteractiveTokenStandardFinalizeFallback(error, escrowParty)) {
        throw error;
      }

      logger.info(
        { sender, streamId, escrowParty },
        'Orchestrator: falling back to interactive finalize for hybrid escrow signer',
      );

      await interactiveFinalizeTokenStandardEscrow(
        contractId,
        escrowParty,
        transferResult.settlementReference,
        depositAmount,
      );

      const interactiveEscrowContractId = await waitForTokenStandardEscrowContractId(
        transport,
        sender,
        streamId,
        actAs,
      );

      result = { contractId: interactiveEscrowContractId };
    }

    const escrowContractId =
      typeof result === 'string'
        ? result
        : result?.contractId ?? result?.contract_id ?? contractId;

    logger.info(
      { streamId, escrowContractId: escrowContractId.slice(0, 20), settlementRef: transferResult.settlementReference.slice(0, 20) },
      'Orchestrator: finalize complete',
    );

    return {
      escrowContractId,
      settlementReference: transferResult.settlementReference,
      escrowReference: escrowParty,
      confirmedEscrowAmount: depositAmount,
    };
  }

  // ---------------------------------------------------------------------------
  // withdraw
  // ---------------------------------------------------------------------------

  /**
   * Compute the withdrawable amount, execute escrow → recipient transfer, update stream.
   *
   * actAs must include: escrowOperator, recipient
   */
  async withdraw(
    transport: Transport,
    sender: string,
    streamId: string,
    actAs: string[],
    logger: Logger,
  ): Promise<OrchestratedWithdrawResult> {
    // [C1 fix — STR-103] Daml TokenStandardEscrow missing; fail closed.
    assertTokenStandardEscrowAvailable();
    logger.info({ sender, streamId }, 'Orchestrator: withdrawing from TokenStandard stream');

    // Load stream
    const stream = await getStream(transport, sender, streamId, actAs, logger);
    if (stream.config.settlementMode !== SettlementMode.TokenStandardCustody) {
      throw new Error(`Stream ${streamId} is not a TokenStandardCustody stream`);
    }
    if (stream.state.status !== StreamStatus.Active) {
      throw new Error(`Stream ${streamId} is not active (status: ${stream.state.status})`);
    }

    // Fix the accrual point once and carry it through both the external settlement
    // and the Daml choice so the on-ledger equality check stays exact.
    const withdrawTime = new Date();
    const balances = getBalances(stream, withdrawTime);
    if (balances.withdrawable.isZero()) {
      throw new Error(`Nothing to withdraw from stream ${streamId} right now`);
    }

    const escrowOperator = stream.escrowRef?.escrowOperator ?? '';
    const recipient = stream.config.recipient;
    const registrar = stream.config.instrumentRef?.issuer ?? '';
    const instrumentId = stream.config.instrumentRef?.instrumentId ?? '';

    if (!escrowOperator || !registrar || !instrumentId) {
      throw new Error(
        `Stream ${streamId} is missing escrow operator or instrument info`,
      );
    }

    // Execute escrow → recipient transfer
    const adapter = await this.selectAdapter(registrar, instrumentId);
    const transferResult = await adapter.transfer(
      {
        from: escrowOperator,
        to: recipient,
        amount: balances.withdrawable,
        registrar,
        instrumentId,
        reference: `withdraw-${streamId}-${withdrawTime.getTime()}`,
      },
      actAs,
      transport,
      logger,
    );

    // Update stream on-ledger
    const withdrawTimeMicros = (BigInt(withdrawTime.getTime()) * 1000n).toString();

    const choiceArgs = {
      withdrawTime: { timestamp: withdrawTimeMicros },
      settlementReference: { text: transferResult.settlementReference },
      settledAmount: { numeric: balances.withdrawable.toFixed(10) },
    };

    const withdrawActAs = [escrowOperator];
    let result: any;
    try {
      result = await transport.exercise<any>(
        TEMPLATE_TOKEN_STANDARD_ESCROW,
        stream.contractId,
        CHOICE_WITHDRAW_TOKEN_STANDARD,
        choiceArgs,
        withdrawActAs,
      );
    } catch (error) {
      if (!shouldUseInteractiveTokenStandardWithdrawFallback(error, escrowOperator)) {
        throw error;
      }

      logger.info(
        { sender, streamId, escrowOperator },
        'Orchestrator: falling back to interactive withdraw for hybrid escrow signer',
      );

      await interactiveWithdrawTokenStandardEscrow(
        stream.contractId,
        escrowOperator,
        withdrawTime,
        transferResult.settlementReference,
        balances.withdrawable,
      );

      const updatedStream = await waitForTokenStandardStreamUpdate(
        transport,
        sender,
        streamId,
        withdrawActAs,
        stream.state.totalWithdrawn.plus(balances.withdrawable),
        transferResult.settlementReference,
      );

      result = {
        amountWithdrawn: balances.withdrawable.toFixed(10),
        newTotalWithdrawn: updatedStream.state.totalWithdrawn.toFixed(10),
        newStatus: updatedStream.state.status,
      };
    }

    logger.info(
      { streamId, amount: balances.withdrawable.toString(), settlementRef: transferResult.settlementReference.slice(0, 20) },
      'Orchestrator: withdraw complete',
    );

    return {
      amountWithdrawn: new Decimal(result?.amountWithdrawn ?? balances.withdrawable),
      newTotalWithdrawn: new Decimal(result?.newTotalWithdrawn ?? stream.state.totalWithdrawn.plus(balances.withdrawable)),
      newStatus: result?.newStatus ?? stream.state.status,
      settlementReference: transferResult.settlementReference,
    };
  }

  // ---------------------------------------------------------------------------
  // cancel / mutualCancel
  // ---------------------------------------------------------------------------

  /**
   * Compute cancel amounts, execute two transfer legs, archive stream.
   *
   * actAs must include: sender, recipient, escrowOperator
   */
  async cancel(
    transport: Transport,
    sender: string,
    streamId: string,
    actAs: string[],
    logger: Logger,
    mutual = false,
  ): Promise<OrchestratedCancelResult> {
    logger.info({ sender, streamId, mutual }, 'Orchestrator: cancelling TokenStandard stream');

    const stream = await getStream(transport, sender, streamId, actAs, logger);
    if (stream.config.settlementMode !== SettlementMode.TokenStandardCustody) {
      throw new Error(`Stream ${streamId} is not a TokenStandardCustody stream`);
    }
    if (stream.state.status !== StreamStatus.Active) {
      throw new Error(`Stream ${streamId} is not active`);
    }
    if (!mutual && !stream.config.cancellable) {
      throw new Error(`Stream ${streamId} is not cancellable by sender alone`);
    }

    // [C1 fix — STR-103] Daml TokenStandardEscrow + workflow modules missing.
    assertTokenStandardEscrowAvailable();

    // [H1 fix] Single `now` for the entire cancel flow. Previously
    // `getBalances(stream)` defaulted to `new Date()` (T1) and
    // `cancelTimeMicros` was constructed from a second `new Date()` (T2);
    // the Daml `MutualCancel_Stream` choice's re-accrual at T2 would fail
    // the equality assertion against the T1-computed split whenever
    // network latency between the two calls was non-trivial.
    const now = new Date();
    const cancelTimeMicros = (BigInt(now.getTime()) * 1000n).toString();
    const balances = getBalances(stream, now);
    const escrowOperator = stream.escrowRef?.escrowOperator ?? '';
    const recipient = stream.config.recipient;
    const registrar = stream.config.instrumentRef?.issuer ?? '';
    const instrumentId = stream.config.instrumentRef?.instrumentId ?? '';

    if (!escrowOperator || !registrar || !instrumentId) {
      throw new Error(`Stream ${streamId} is missing escrow operator or instrument info`);
    }

    const adapter = await this.selectAdapter(registrar, instrumentId);

    // Leg 1: escrow → recipient (vested but not yet withdrawn)
    let recipientResult: TransferResult | undefined;
    if (balances.withdrawable.greaterThan(0)) {
      recipientResult = await adapter.transfer(
        {
          from: escrowOperator,
          to: recipient,
          amount: balances.withdrawable,
          registrar,
          instrumentId,
          reference: `cancel-recipient-${streamId}`,
        },
        actAs,
        transport,
        logger,
      );
    }

    // Leg 2: escrow → sender (unvested refund)
    let senderResult: TransferResult | undefined;
    if (balances.refundable.greaterThan(0)) {
      senderResult = await adapter.transfer(
        {
          from: escrowOperator,
          to: sender,
          amount: balances.refundable,
          registrar,
          instrumentId,
          reference: `cancel-refund-${streamId}`,
        },
        actAs,
        transport,
        logger,
      );
    }

    // Archive stream on-ledger
    const choiceName = mutual
      ? CHOICE_MUTUAL_CANCEL_TOKEN_STANDARD
      : CHOICE_CANCEL_TOKEN_STANDARD;

    const choiceArgs = {
      cancelTime: { timestamp: cancelTimeMicros },
      recipientSettlementReference: recipientResult
        ? { optional: { text: recipientResult.settlementReference } }
        : { optional: null },
      senderRefundReference: senderResult
        ? { optional: { text: senderResult.settlementReference } }
        : { optional: null },
      recipientAmountSettled: { numeric: balances.withdrawable.toFixed(10) },
      senderRefundSettled: { numeric: balances.refundable.toFixed(10) },
    };

    const result = await transport.exercise<any>(
      TEMPLATE_TOKEN_STANDARD_ESCROW,
      stream.contractId,
      choiceName,
      choiceArgs,
      actAs,
    );

    logger.info(
      { streamId, recipientAmount: balances.withdrawable.toString(), senderRefund: balances.refundable.toString() },
      'Orchestrator: cancel complete',
    );

    return {
      recipientAmount: new Decimal(result?.recipientAmount ?? balances.withdrawable),
      senderRefund: new Decimal(result?.senderRefund ?? balances.refundable),
      recipientSettlementReference: recipientResult?.settlementReference,
      senderRefundReference: senderResult?.settlementReference,
    };
  }

  // ---------------------------------------------------------------------------
  // renew
  // ---------------------------------------------------------------------------

  /**
   * Execute sender → escrow top-up transfer, then renew the stream.
   *
   * actAs must include: sender, escrowOperator
   */
  async renew(
    transport: Transport,
    sender: string,
    streamId: string,
    params: RenewParams,
    actAs: string[],
    logger: Logger,
  ): Promise<OrchestratedRenewResult> {
    // [C1 fix — STR-103] Daml TokenStandardEscrow missing; fail closed.
    assertTokenStandardEscrowAvailable();
    logger.info({ sender, streamId, additionalAmount: params.additionalAmount.toString() }, 'Orchestrator: renewing TokenStandard stream');

    const stream = await getStream(transport, sender, streamId, actAs, logger);
    if (stream.config.settlementMode !== SettlementMode.TokenStandardCustody) {
      throw new Error(`Stream ${streamId} is not a TokenStandardCustody stream`);
    }

    const escrowOperator = stream.escrowRef?.escrowOperator ?? '';
    const registrar = stream.config.instrumentRef?.issuer ?? '';
    const instrumentId = stream.config.instrumentRef?.instrumentId ?? '';

    if (!escrowOperator || !registrar || !instrumentId) {
      throw new Error(`Stream ${streamId} is missing escrow operator or instrument info`);
    }

    const adapter = await this.selectAdapter(registrar, instrumentId);

    // Execute sender → escrow top-up
    const topUpResult = await adapter.transfer(
      {
        from: sender,
        to: escrowOperator,
        amount: params.additionalAmount,
        registrar,
        instrumentId,
        reference: `renew-${streamId}-${Date.now()}`,
      },
      actAs,
      transport,
      logger,
    );

    const newEndTimeMicros = (BigInt(params.newEndTime.getTime()) * 1000n).toString();

    const choiceArgs = {
      additionalDeposit: { numeric: params.additionalAmount.toFixed(10) },
      newEndTime: { timestamp: newEndTimeMicros },
      fundingReference: { text: topUpResult.settlementReference },
      settlementReference: { text: topUpResult.settlementReference },
      confirmedAdditionalAmount: { numeric: params.additionalAmount.toFixed(10) },
    };

    const result = await transport.exercise<any>(
      TEMPLATE_TOKEN_STANDARD_ESCROW,
      stream.contractId,
      CHOICE_RENEW_TOKEN_STANDARD,
      choiceArgs,
      actAs,
    );

    const contractId =
      typeof result === 'string'
        ? result
        : result?.contractId ?? result?.contract_id ?? stream.contractId;

    logger.info({ streamId, contractId: contractId.slice(0, 20) }, 'Orchestrator: renew complete');

    return {
      contractId,
      settlementReference: topUpResult.settlementReference,
      confirmedAdditionalAmount: params.additionalAmount,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async selectAdapter(
    registrar: string,
    instrumentId: string,
  ): Promise<SettlementAdapter> {
    for (const adapter of this.adapters) {
      if (await adapter.canHandle(registrar, instrumentId)) {
        return adapter;
      }
    }
    throw new Error(
      `No settlement adapter available for registrar=${registrar.split('::')[0]}, ` +
      `instrumentId=${instrumentId}. ` +
      `Register a TransferRuleAdapter or TransferOfferAdapter for this registrar.`,
    );
  }

  private async loadAcceptedRequest(
    transport: Transport,
    sender: string,
    streamId: string,
    actAs: string[],
    logger: Logger,
    contractId?: string,
  ): Promise<{
    contractId: string;
    depositAmount: Decimal;
    config: { instrumentRef?: { issuer: string; instrumentId: string }; recipient: string };
  }> {
    // [M4 fix] Use server-side filter on the Ledger API where supported,
    // rather than full-scanning the ACS and filtering in-process. Falls
    // back to client-side filter for transports that don't accept
    // arg-payload filters. The `query` call passes a `queryFilter`
    // object whose keys are interpreted by the transport as payload
    // filters; transports that don't support it ignore it (and we
    // re-filter client-side as defense in depth).
    if (contractId) {
      const results = await transport.query<any>(
        TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST,
        undefined,
        actAs,
        undefined,
      );
      const match = results.find((r: any) =>
        (r.contractId ?? r.contract_id) === contractId,
      );
      if (match) {
        return this.extractAcceptedRequestFields(contractId, match);
      }
    }

    // Search by sender + streamId. Try server-side payload filter first.
    const filterPayload = {
      'config.sender': sender,
      'config.streamId': streamId,
    } as Record<string, unknown>;
    const results = await transport.query<any>(
      TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST,
      filterPayload as unknown as undefined,
      actAs,
      undefined,
    );

    // Defense-in-depth: re-filter client-side in case the transport
    // ignored the server-side filter (older Ledger API versions).
    const match = results.find((r: any) => {
      const config = r.config ?? r;
      return config.sender === sender && config.streamId === streamId;
    });

    if (!match) {
      throw new Error(
        `No AcceptedTokenStandardStreamRequest found for sender=${sender.split('::')[0]}, streamId=${streamId}`,
      );
    }

    const cid = match.contractId ?? match.contract_id ?? '';
    logger.debug({ cid: cid.slice(0, 20) }, 'Found AcceptedTokenStandardStreamRequest');
    return this.extractAcceptedRequestFields(cid, match);
  }

  private extractAcceptedRequestFields(
    contractId: string,
    raw: any,
  ): {
    contractId: string;
    depositAmount: Decimal;
    config: { instrumentRef?: { issuer: string; instrumentId: string }; recipient: string };
  } {
    const depositAmount = new Decimal(raw.depositAmount ?? raw.deposit_amount ?? '0');
    const config = raw.config ?? raw;
    const instrRef = config.instrumentRef;
    return {
      contractId,
      depositAmount,
      config: {
        recipient: config.recipient ?? '',
        instrumentRef: instrRef
          ? { issuer: instrRef.issuer ?? '', instrumentId: instrRef.instrumentId ?? '' }
          : undefined,
      },
    };
  }
}

interface InteractivePrepareResponse {
  readonly preparedTransactionHash?: string | null;
  readonly preparedTransaction?: string | null;
  readonly hashingSchemeVersion?: string | null;
  readonly deduplicationPeriod?: Record<string, unknown> | null;
}

function shouldUseInteractiveTokenStandardFinalizeFallback(
  error: unknown,
  escrowParty: string,
): boolean {
  const message = String(error instanceof Error ? error.message : error);
  if (!message.includes('NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT')) {
    return false;
  }
  return hasInteractiveFinalizeCredentials(escrowParty);
}

function shouldUseInteractiveTokenStandardWithdrawFallback(
  error: unknown,
  escrowParty: string,
): boolean {
  const message = String(error instanceof Error ? error.message : error);
  if (!message.includes('NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT')) {
    return false;
  }
  return hasInteractiveFinalizeCredentials(escrowParty);
}

function hasInteractiveFinalizeCredentials(escrowParty: string): boolean {
  const credentials = readHostedWalletCredentialMapFromEnv()[escrowParty];
  return Boolean(
    credentials?.publicKey &&
    (credentials.privateKey || credentials.privateKeyFile) &&
    trimToUndefined(process.env['CANTON_JSON_API_URL']) &&
    trimToUndefined(process.env['CANTON_LEDGER_TOKEN'] ?? process.env['LEDGER_TOKEN']) &&
    trimToUndefined(
      process.env['CANTON_USER_ID'] ??
      process.env['COMMAND_USER_ID'] ??
      process.env['CANTON_JSON_API_TOKEN_SUB'],
    ) &&
    trimToUndefined(
      process.env['CANTON_STREAMS_WALLET_GATEWAY_SYNCHRONIZER_ID'] ??
      process.env['SYNCHRONIZER_ID'],
    ),
  );
}

async function interactiveFinalizeTokenStandardEscrow(
  acceptedRequestContractId: string,
  escrowParty: string,
  settlementReference: string,
  confirmedEscrowAmount: Decimal,
): Promise<void> {
  const credentials = readHostedWalletCredentialMapFromEnv()[escrowParty];
  if (!credentials?.publicKey || (!credentials.privateKey && !credentials.privateKeyFile)) {
    throw new Error(
      `Interactive finalize requires wallet-gateway signer credentials for ${escrowParty}.`,
    );
  }

  const jsonApiUrl = trimToUndefined(process.env['CANTON_JSON_API_URL']);
  const ledgerToken = trimToUndefined(
    process.env['CANTON_LEDGER_TOKEN'] ?? process.env['LEDGER_TOKEN'],
  );
  const userId = trimToUndefined(
    process.env['CANTON_USER_ID'] ??
    process.env['COMMAND_USER_ID'] ??
    process.env['CANTON_JSON_API_TOKEN_SUB'],
  );
  const synchronizerId = trimToUndefined(
    process.env['CANTON_STREAMS_WALLET_GATEWAY_SYNCHRONIZER_ID'] ??
    process.env['SYNCHRONIZER_ID'],
  );

  if (!jsonApiUrl || !ledgerToken || !userId || !synchronizerId) {
    throw new Error(
      'Interactive finalize requires CANTON_JSON_API_URL, CANTON_LEDGER_TOKEN, ' +
      'CANTON_USER_ID/COMMAND_USER_ID, and SYNCHRONIZER_ID.',
    );
  }

  const commandId = `canton-streams.finalize.${Date.now()}`;
  const prepareBody = {
    userId,
    commandId,
    commands: [
      {
        ExerciseCommand: {
          templateId: formatTemplateId(TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST),
          contractId: acceptedRequestContractId,
          choice: CHOICE_FINALIZE_TOKEN_STANDARD_ESCROW,
          choiceArgument: {
            escrowReference: escrowParty,
            settlementReference,
            confirmedEscrowAmount: confirmedEscrowAmount.toFixed(10),
          },
        },
      },
    ],
    actAs: [escrowParty],
    readAs: [],
    synchronizerId,
    disclosedContracts: [],
    verboseHashing: false,
    packageIdSelectionPreference: [],
  };

  const prepared = await requestInteractiveLedgerJson<InteractivePrepareResponse>(
    jsonApiUrl,
    ledgerToken,
    '/v2/interactive-submission/prepare',
    {
      method: 'POST',
      body: prepareBody,
    },
  );

  const preparedTransactionHash = trimToUndefined(prepared.preparedTransactionHash);
  const preparedTransaction = trimToUndefined(prepared.preparedTransaction);
  if (!preparedTransactionHash || !preparedTransaction) {
    throw new Error('Interactive finalize prepare did not return a signable transaction.');
  }

  const executeBody = {
    userId,
    preparedTransaction,
    hashingSchemeVersion:
      trimToUndefined(prepared.hashingSchemeVersion) ?? 'HASHING_SCHEME_VERSION_V2',
    submissionId: commandId,
    deduplicationPeriod:
      prepared.deduplicationPeriod && typeof prepared.deduplicationPeriod === 'object'
        ? prepared.deduplicationPeriod
        : { Empty: {} },
    partySignatures: {
      signatures: [
        {
          party: escrowParty,
          signatures: [
            {
              signature: signPreparedHash(preparedTransactionHash, credentials),
              signedBy: escrowParty.split('::').at(-1) ?? '',
              format: 'SIGNATURE_FORMAT_CONCAT',
              signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519',
            },
          ],
        },
      ],
    },
  };

  try {
    await requestInteractiveLedgerJson<Record<string, unknown>>(
      jsonApiUrl,
      ledgerToken,
      '/v2/interactive-submission/executeAndWait',
      {
        method: 'POST',
        body: executeBody,
      },
    );
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).toLowerCase();
    const shouldTreatAsPending =
      message.includes('http 503') ||
      message.includes('http 504') ||
      message.includes('timely response') ||
      message.includes('gateway timeout');
    const shouldFallback =
      message.includes('404') ||
      message.includes('405') ||
      message.includes('method not allowed') ||
      message.includes('unsupported endpoint') ||
      message.includes('not found');
    if (shouldTreatAsPending) {
      return;
    }
    if (!shouldFallback) {
      throw error;
    }

    await requestInteractiveLedgerJson<Record<string, unknown>>(
      jsonApiUrl,
      ledgerToken,
      '/v2/interactive-submission/execute',
      {
        method: 'POST',
        body: executeBody,
      },
    );
  }
}

async function interactiveWithdrawTokenStandardEscrow(
  escrowContractId: string,
  escrowParty: string,
  withdrawTime: Date,
  settlementReference: string,
  settledAmount: Decimal,
): Promise<void> {
  const credentials = readHostedWalletCredentialMapFromEnv()[escrowParty];
  if (!credentials?.publicKey || (!credentials.privateKey && !credentials.privateKeyFile)) {
    throw new Error(
      `Interactive withdraw requires wallet-gateway signer credentials for ${escrowParty}.`,
    );
  }

  const jsonApiUrl = trimToUndefined(process.env['CANTON_JSON_API_URL']);
  const ledgerToken = trimToUndefined(
    process.env['CANTON_LEDGER_TOKEN'] ?? process.env['LEDGER_TOKEN'],
  );
  const userId = trimToUndefined(
    process.env['CANTON_USER_ID'] ??
    process.env['COMMAND_USER_ID'] ??
    process.env['CANTON_JSON_API_TOKEN_SUB'],
  );
  const synchronizerId = trimToUndefined(
    process.env['CANTON_STREAMS_WALLET_GATEWAY_SYNCHRONIZER_ID'] ??
    process.env['SYNCHRONIZER_ID'],
  );

  if (!jsonApiUrl || !ledgerToken || !userId || !synchronizerId) {
    throw new Error(
      'Interactive withdraw requires CANTON_JSON_API_URL, CANTON_LEDGER_TOKEN, ' +
      'CANTON_USER_ID/COMMAND_USER_ID, and SYNCHRONIZER_ID.',
    );
  }

  const commandId = `canton-streams.withdraw.${Date.now()}`;
  const prepareBody = {
    userId,
    commandId,
    commands: [
      {
        ExerciseCommand: {
          templateId: formatTemplateId(TEMPLATE_TOKEN_STANDARD_ESCROW),
          contractId: escrowContractId,
          choice: CHOICE_WITHDRAW_TOKEN_STANDARD,
          choiceArgument: {
            withdrawTime: withdrawTime.toISOString(),
            settlementReference,
            settledAmount: settledAmount.toFixed(10),
          },
        },
      },
    ],
    actAs: [escrowParty],
    readAs: [],
    synchronizerId,
    disclosedContracts: [],
    verboseHashing: false,
    packageIdSelectionPreference: [],
  };

  const prepared = await requestInteractiveLedgerJson<InteractivePrepareResponse>(
    jsonApiUrl,
    ledgerToken,
    '/v2/interactive-submission/prepare',
    {
      method: 'POST',
      body: prepareBody,
    },
  );

  const preparedTransactionHash = trimToUndefined(prepared.preparedTransactionHash);
  const preparedTransaction = trimToUndefined(prepared.preparedTransaction);
  if (!preparedTransactionHash || !preparedTransaction) {
    throw new Error('Interactive withdraw prepare did not return a signable transaction.');
  }

  const executeBody = {
    userId,
    preparedTransaction,
    hashingSchemeVersion:
      trimToUndefined(prepared.hashingSchemeVersion) ?? 'HASHING_SCHEME_VERSION_V2',
    submissionId: commandId,
    deduplicationPeriod:
      prepared.deduplicationPeriod && typeof prepared.deduplicationPeriod === 'object'
        ? prepared.deduplicationPeriod
        : { Empty: {} },
    partySignatures: {
      signatures: [
        {
          party: escrowParty,
          signatures: [
            {
              signature: signPreparedHash(preparedTransactionHash, credentials),
              signedBy: escrowParty.split('::').at(-1) ?? '',
              format: 'SIGNATURE_FORMAT_CONCAT',
              signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519',
            },
          ],
        },
      ],
    },
  };

  try {
    await requestInteractiveLedgerJson<Record<string, unknown>>(
      jsonApiUrl,
      ledgerToken,
      '/v2/interactive-submission/executeAndWait',
      {
        method: 'POST',
        body: executeBody,
      },
    );
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).toLowerCase();
    const shouldTreatAsPending =
      message.includes('http 503') ||
      message.includes('http 504') ||
      message.includes('timely response') ||
      message.includes('gateway timeout');
    const shouldFallback =
      message.includes('404') ||
      message.includes('405') ||
      message.includes('method not allowed') ||
      message.includes('unsupported endpoint') ||
      message.includes('not found');
    if (shouldTreatAsPending) {
      return;
    }
    if (!shouldFallback) {
      throw error;
    }

    await requestInteractiveLedgerJson<Record<string, unknown>>(
      jsonApiUrl,
      ledgerToken,
      '/v2/interactive-submission/execute',
      {
        method: 'POST',
        body: executeBody,
      },
    );
  }
}

async function waitForTokenStandardEscrowContractId(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const rows = await transport.query<any>(
        TEMPLATE_TOKEN_STANDARD_ESCROW,
        undefined,
        actAs,
      );
      const match = rows.find((row) => {
        const config = row?.config ?? row;
        return config?.sender === sender && config?.streamId === streamId;
      });
      const contractId = match?.contractId ?? match?.contract_id ?? match?._contractId;
      if (typeof contractId === 'string' && contractId) {
        return contractId;
      }
    } catch {
      // wait for the interactive completion to become visible
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for TokenStandardEscrow after interactive finalize for ${streamId}.`,
  );
}

async function waitForTokenStandardStreamUpdate(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  expectedTotalWithdrawn: Decimal,
  settlementReference: string,
): Promise<Awaited<ReturnType<typeof getStream>>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const stream = await getStream(transport, sender, streamId, actAs, {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as unknown as Logger);
      const matchesSettlementReference =
        stream.escrowRef?.lastSettlementReference === settlementReference ||
        stream.state.status === StreamStatus.Completed;
      if (
        stream.state.totalWithdrawn.greaterThanOrEqualTo(expectedTotalWithdrawn) &&
        matchesSettlementReference
      ) {
        return stream;
      }
    } catch {
      // wait for the interactive completion to become visible
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for TokenStandardEscrow withdraw update for ${streamId}.`,
  );
}

async function requestInteractiveLedgerJson<T>(
  baseUrl: string,
  token: string,
  path: string,
  options: {
    readonly method: 'GET' | 'POST';
    readonly body?: Record<string, unknown>;
  },
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const rendered = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    throw new Error(`HTTP ${response.status} ${path}: ${rendered}`);
  }

  return (payload ?? {}) as T;
}

function formatTemplateId(templateId: {
  readonly packageId: string;
  readonly moduleName: string;
  readonly entityName: string;
}): string {
  return `${templateId.packageId}:${templateId.moduleName}:${templateId.entityName}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a pre-configured SettlementOrchestrator with the default adapter stack.
 *
 * Adapter priority (first match wins):
 *   1. AmuletWalletGatewayAdapter — native CC / Amulet via validator wallet-gateway
 *   2. TransferOfferAdapter       — CBTC / external registrars (throws until HolderService exists)
 *   3. TransferRuleAdapter        — local tokens with a published TransferRule
 *
 * The specialized adapters are checked first so native CC / external-token
 * errors stay specific rather than confusingly falling through to TransferRule.
 */
export function createDefaultOrchestrator(): SettlementOrchestrator {
  return new SettlementOrchestrator([
    new AmuletWalletGatewayAdapter(),
    new TransferOfferAdapter(),
    new TransferRuleAdapter(),
  ]);
}
