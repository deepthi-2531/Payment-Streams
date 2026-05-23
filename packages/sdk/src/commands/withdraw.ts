/**
 * Stream withdrawal command.
 *
 * Auto-detects the settlement mode by looking up the escrow contract
 * across all escrow template types, then exercises the appropriate choice:
 * - NumericLegacy: Withdraw_Stream on StreamEscrow
 * - UtilityHoldingCustody: Withdraw_UtilityHolding on UtilityHoldingEscrow
 *
 * @module commands/withdraw
 */

import type { Transport } from '../transport/base.js';
import type { TokenStandardWithdrawParams, WithdrawResult } from '../types/stream.js';
import { SettlementMode } from '../types/stream.js';
import type { Logger } from 'pino';
import Decimal from 'decimal.js';
import { findContractAcrossTemplates } from './lookup.js';
import {
  CHOICE_WITHDRAW_STREAM,
  CHOICE_WITHDRAW_UTILITY,
  CHOICE_WITHDRAW_TOKEN_STANDARD,
  CHOICE_WITHDRAW_LOCAL_ASSET,
  ESCROW_TEMPLATES,
  assertTokenStandardEscrowAvailable,
} from '../templates.js';

/**
 * Withdraw accrued tokens from a stream.
 *
 * Only the recipient can withdraw. On-ledger, this:
 *   1. Computes accrued via the Daml accrual calculator
 *   2. Splits the escrow balance / holding
 *   3. Archives the old contract and creates an updated one
 *
 * The withdrawTime is sent as a Daml Time (microseconds since epoch).
 */
export async function withdraw(
  transport: Transport,
  sender: string,
  streamId: string,
  params: TokenStandardWithdrawParams | undefined,
  actAs: string[],
  logger: Logger,
): Promise<WithdrawResult> {
  logger.info({ sender, streamId }, 'Withdrawing from stream');

  // Auto-detect which escrow template this stream is on
  const lookup = await findContractAcrossTemplates(
    transport,
    ESCROW_TEMPLATES,
    sender,
    streamId,
    actAs,
  );

  // Use caller-supplied withdrawTime if provided (so settledAmount matches exactly),
  // otherwise default to the current time.
  const now = params?.withdrawTime ?? new Date();
  const withdrawTimeMicros = (BigInt(now.getTime()) * 1000n).toString();

  let choiceName: string;
  let choiceArgs: Record<string, unknown>;
  switch (lookup.settlementMode) {
    case SettlementMode.UtilityHoldingCustody:
      choiceName = CHOICE_WITHDRAW_UTILITY;
      choiceArgs = { withdrawTime: { timestamp: withdrawTimeMicros } };
      break;
    case SettlementMode.TokenStandardCustody:
      // [C1 fix — STR-103] Fail closed before any submit. The
      // TokenStandardEscrow Daml template is missing from the package;
      // submitting would otherwise produce an opaque "template not
      // found" at the ledger.
      assertTokenStandardEscrowAvailable();
      if (!params?.settlementReference?.trim()) {
        throw new Error('settlementReference is required for TokenStandardCustody withdrawals');
      }
      choiceName = CHOICE_WITHDRAW_TOKEN_STANDARD;
      choiceArgs = {
        withdrawTime: { timestamp: withdrawTimeMicros },
        settlementReference: { text: params.settlementReference.trim() },
        // Use toFixed(10) not toString() to avoid scientific notation (e.g. "5e-8")
        // for very small values. Daml's Numeric parser only accepts decimal notation.
        settledAmount: { numeric: params.settledAmount.toFixed(10) },
      };
      break;
    case SettlementMode.LocalAssetCustody:
      choiceName = CHOICE_WITHDRAW_LOCAL_ASSET;
      choiceArgs = { withdrawTime: { timestamp: withdrawTimeMicros } };
      break;
    case SettlementMode.NumericLegacy:
    default:
      choiceName = CHOICE_WITHDRAW_STREAM;
      choiceArgs = { withdrawTime: { timestamp: withdrawTimeMicros } };
      break;
  }

  const result = await transport.exercise<any>(
    lookup.templateId,
    lookup.contractId,
    choiceName,
    choiceArgs,
    actAs,
  );

  const withdrawResult: WithdrawResult = {
    amountWithdrawn: new Decimal(result.amountWithdrawn),
    newTotalWithdrawn: new Decimal(result.newTotalWithdrawn),
    newStatus: result.newStatus,
  };

  logger.info(
    { sender, streamId, amount: withdrawResult.amountWithdrawn.toString(), settlementMode: lookup.settlementMode },
    'Withdrawal complete',
  );

  return withdrawResult;
}
