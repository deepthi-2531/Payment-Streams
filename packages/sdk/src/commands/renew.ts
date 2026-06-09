/**
 * Stream renewal command.
 *
 * Auto-detects the settlement mode by looking up the escrow contract
 * across all escrow template types, then exercises the appropriate choice:
 * - NumericLegacy: Renew_Stream on StreamEscrow
 * - UtilityHoldingCustody: Renew_UtilityHolding on UtilityHoldingEscrow
 *
 * @module commands/renew
 */

import type { Transport } from '../transport/base.js';
import type { RenewParams } from '../types/stream.js';
import { SettlementMode } from '../types/stream.js';
import { RenewParamsSchema, validate } from '../utils/validation.js';
import type { Logger } from 'pino';
import { findContractAcrossTemplates } from './lookup.js';
import {
  CHOICE_RENEW_STREAM,
  CHOICE_RENEW_UTILITY,
  CHOICE_RENEW_TOKEN_STANDARD,
  CHOICE_RENEW_LOCAL_ASSET,
  ESCROW_TEMPLATES,
  assertTokenStandardEscrowAvailable,
} from '../templates.js';

/**
 * Renew a renewable-term stream with additional deposit and extended end time.
 * Only the sender can renew.
 */
export async function renew(
  transport: Transport,
  sender: string,
  streamId: string,
  params: RenewParams,
  actAs: string[],
  logger: Logger,
): Promise<string> {
  const validated = validate(RenewParamsSchema, params);

  logger.info(
    { sender, streamId, additionalAmount: validated.additionalAmount.toString() },
    'Renewing stream',
  );

  const lookup = await findContractAcrossTemplates(
    transport,
    ESCROW_TEMPLATES,
    sender,
    streamId,
    actAs,
  );

  const newEndTimeMicros = (BigInt(validated.newEndTime.getTime()) * 1000n).toString();

  let choiceArgs: Record<string, unknown>;
  let choiceName: string;

  switch (lookup.settlementMode) {
    case SettlementMode.UtilityHoldingCustody:
      if (!validated.holdingCid) {
        throw new Error('holdingCid is required to renew UtilityHoldingCustody streams');
      }
      choiceName = CHOICE_RENEW_UTILITY;
      choiceArgs = {
        additionalDeposit: { numeric: validated.additionalAmount.toString() },
        newEndTime: { timestamp: newEndTimeMicros },
        additionalHoldingCid: { contract_id: validated.holdingCid },
      };
      break;
    case SettlementMode.TokenStandardCustody:
      // Legacy TokenStandardEscrow templates are not shipped; fail closed.
      assertTokenStandardEscrowAvailable();
      if (!validated.fundingReference?.trim()) {
        throw new Error('fundingReference is required to renew TokenStandardCustody streams');
      }
      if (!validated.settlementReference?.trim()) {
        throw new Error('settlementReference is required to renew TokenStandardCustody streams');
      }
      if (!validated.confirmedAdditionalAmount) {
        throw new Error('confirmedAdditionalAmount is required to renew TokenStandardCustody streams');
      }
      choiceName = CHOICE_RENEW_TOKEN_STANDARD;
      choiceArgs = {
        additionalDeposit: { numeric: validated.additionalAmount.toString() },
        newEndTime: { timestamp: newEndTimeMicros },
        fundingReference: { text: validated.fundingReference.trim() },
        settlementReference: { text: validated.settlementReference.trim() },
        confirmedAdditionalAmount: { numeric: validated.confirmedAdditionalAmount.toString() },
      };
      break;
    case SettlementMode.LocalAssetCustody:
      if (!validated.holdingCid) {
        throw new Error('holdingCid is required to renew LocalAssetCustody streams');
      }
      choiceName = CHOICE_RENEW_LOCAL_ASSET;
      choiceArgs = {
        additionalDeposit: { numeric: validated.additionalAmount.toString() },
        newEndTime: { timestamp: newEndTimeMicros },
        additionalHoldingCid: { text: validated.holdingCid },
      };
      break;
    case SettlementMode.NumericLegacy:
    default:
      choiceName = CHOICE_RENEW_STREAM;
      choiceArgs = {
        additionalDeposit: { numeric: validated.additionalAmount.toString() },
        newEndTime: { timestamp: newEndTimeMicros },
      };
      break;
  }

  const result = await transport.exercise<any>(
    lookup.templateId,
    lookup.contractId,
    choiceName,
    choiceArgs,
    actAs,
  );

  logger.info({ sender, streamId, settlementMode: lookup.settlementMode }, 'Stream renewed');

  return result as string;
}
