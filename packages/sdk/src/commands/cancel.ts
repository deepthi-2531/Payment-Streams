/**
 * Stream cancellation commands.
 *
 * Auto-detects the settlement mode by looking up the escrow contract
 * across all escrow template types, then exercises the appropriate choice:
 * - NumericLegacy: Cancel_Stream / MutualCancel_Stream
 * - UtilityHoldingCustody: Cancel_UtilityHolding / MutualCancel_UtilityHolding
 *
 * @module commands/cancel
 */

import type { Transport } from '../transport/base.js';
import type { CancelResult, TokenStandardCancelParams } from '../types/stream.js';
import { SettlementMode } from '../types/stream.js';
import type { Logger } from 'pino';
import Decimal from 'decimal.js';
import { findContractAcrossTemplates } from './lookup.js';
import {
  CHOICE_CANCEL_STREAM,
  CHOICE_MUTUAL_CANCEL_STREAM,
  CHOICE_CANCEL_UTILITY,
  CHOICE_MUTUAL_CANCEL_UTILITY,
  CHOICE_CANCEL_TOKEN_STANDARD,
  CHOICE_MUTUAL_CANCEL_TOKEN_STANDARD,
  CHOICE_CANCEL_LOCAL_ASSET,
  CHOICE_MUTUAL_CANCEL_LOCAL_ASSET,
  ESCROW_TEMPLATES,
  assertTokenStandardEscrowAvailable,
} from '../templates.js';

/**
 * Cancel a cancellable stream. Only the sender can call this.
 * Pro-rata settlement: accrued goes to recipient, remainder to sender.
 */
export async function cancel(
  transport: Transport,
  sender: string,
  streamId: string,
  params: TokenStandardCancelParams | undefined,
  actAs: string[],
  logger: Logger,
): Promise<CancelResult> {
  logger.info({ sender, streamId }, 'Cancelling stream');

  const lookup = await findContractAcrossTemplates(
    transport,
    ESCROW_TEMPLATES,
    sender,
    streamId,
    actAs,
  );

  // Use caller-supplied cancelTime when provided (ensures Daml accrual check
  // uses the same moment the caller computed recipientAmountSettled / senderRefundSettled).
  const cancelTimestamp = params && 'cancelTime' in params && params.cancelTime instanceof Date
    ? params.cancelTime
    : new Date();
  const cancelTimeMicros = (BigInt(cancelTimestamp.getTime()) * 1000n).toString();

  let choiceName: string;
  let choiceArgs: Record<string, unknown>;
  switch (lookup.settlementMode) {
    case SettlementMode.UtilityHoldingCustody:
      choiceName = CHOICE_CANCEL_UTILITY;
      choiceArgs = { cancelTime: { timestamp: cancelTimeMicros } };
      break;
    case SettlementMode.TokenStandardCustody:
      // [C1 fix — STR-103] Daml template missing; fail closed.
      assertTokenStandardEscrowAvailable();
      if (!params) {
        throw new Error('TokenStandardCustody cancellation requires confirmed settlement details');
      }
      choiceName = CHOICE_CANCEL_TOKEN_STANDARD;
      choiceArgs = {
        cancelTime: { timestamp: cancelTimeMicros },
        recipientSettlementReference: params.recipientSettlementReference?.trim()
          ? { optional: { text: params.recipientSettlementReference.trim() } }
          : { optional: null },
        senderRefundReference: params.senderRefundReference?.trim()
          ? { optional: { text: params.senderRefundReference.trim() } }
          : { optional: null },
        recipientAmountSettled: { numeric: params.recipientAmountSettled.toFixed(10) },
        senderRefundSettled: { numeric: params.senderRefundSettled.toFixed(10) },
      };
      break;
    case SettlementMode.LocalAssetCustody:
      choiceName = CHOICE_CANCEL_LOCAL_ASSET;
      choiceArgs = { cancelTime: { timestamp: cancelTimeMicros } };
      break;
    case SettlementMode.NumericLegacy:
    default:
      choiceName = CHOICE_CANCEL_STREAM;
      choiceArgs = { cancelTime: { timestamp: cancelTimeMicros } };
      break;
  }

  const result = await transport.exercise<any>(
    lookup.templateId,
    lookup.contractId,
    choiceName,
    choiceArgs,
    actAs,
  );

  const cancelResult: CancelResult = {
    recipientAmount: new Decimal(result.recipientAmount),
    senderRefund: new Decimal(result.senderRefund),
  };

  logger.info(
    {
      sender,
      streamId,
      recipientAmount: cancelResult.recipientAmount.toString(),
      senderRefund: cancelResult.senderRefund.toString(),
      settlementMode: lookup.settlementMode,
    },
    'Stream cancelled',
  );

  return cancelResult;
}

/**
 * Mutual cancellation — requires both sender and recipient to authorize.
 */
export async function mutualCancel(
  transport: Transport,
  sender: string,
  streamId: string,
  params: TokenStandardCancelParams | undefined,
  actAs: string[],
  logger: Logger,
): Promise<CancelResult> {
  logger.info({ sender, streamId }, 'Mutual cancelling stream');

  const lookup = await findContractAcrossTemplates(
    transport,
    ESCROW_TEMPLATES,
    sender,
    streamId,
    actAs,
  );

  // Use caller-supplied cancelTime when provided (ensures Daml accrual check
  // uses the same moment the caller computed recipientAmountSettled / senderRefundSettled).
  const mutualCancelTimestamp = params && 'cancelTime' in params && params.cancelTime instanceof Date
    ? params.cancelTime
    : new Date();
  const cancelTimeMicros = (BigInt(mutualCancelTimestamp.getTime()) * 1000n).toString();

  let choiceName: string;
  let choiceArgs: Record<string, unknown>;
  switch (lookup.settlementMode) {
    case SettlementMode.UtilityHoldingCustody:
      choiceName = CHOICE_MUTUAL_CANCEL_UTILITY;
      choiceArgs = { cancelTime: { timestamp: cancelTimeMicros } };
      break;
    case SettlementMode.TokenStandardCustody:
      // [C1 fix — STR-103] Daml template missing; fail closed.
      assertTokenStandardEscrowAvailable();
      if (!params) {
        throw new Error('TokenStandardCustody mutual cancellation requires confirmed settlement details');
      }
      choiceName = CHOICE_MUTUAL_CANCEL_TOKEN_STANDARD;
      choiceArgs = {
        cancelTime: { timestamp: cancelTimeMicros },
        recipientSettlementReference: params.recipientSettlementReference?.trim()
          ? { optional: { text: params.recipientSettlementReference.trim() } }
          : { optional: null },
        senderRefundReference: params.senderRefundReference?.trim()
          ? { optional: { text: params.senderRefundReference.trim() } }
          : { optional: null },
        recipientAmountSettled: { numeric: params.recipientAmountSettled.toFixed(10) },
        senderRefundSettled: { numeric: params.senderRefundSettled.toFixed(10) },
      };
      break;
    case SettlementMode.LocalAssetCustody:
      choiceName = CHOICE_MUTUAL_CANCEL_LOCAL_ASSET;
      choiceArgs = { cancelTime: { timestamp: cancelTimeMicros } };
      break;
    case SettlementMode.NumericLegacy:
    default:
      choiceName = CHOICE_MUTUAL_CANCEL_STREAM;
      choiceArgs = { cancelTime: { timestamp: cancelTimeMicros } };
      break;
  }

  const result = await transport.exercise<any>(
    lookup.templateId,
    lookup.contractId,
    choiceName,
    choiceArgs,
    actAs,
  );

  return {
    recipientAmount: new Decimal(result.recipientAmount),
    senderRefund: new Decimal(result.senderRefund),
  };
}
