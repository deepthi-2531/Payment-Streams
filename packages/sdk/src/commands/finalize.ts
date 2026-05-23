/**
 * Escrow custody finalization command.
 *
 * After a recipient accepts a custody-backed stream request, the escrow
 * operator must finalize custody by exercising FinalizeUtilityHoldingEscrow
 * or FinalizeLocalAssetEscrow on the AcceptedRequest contract.
 *
 * This command:
 *   1. Looks up the accepted request across custody templates
 *   2. Exercises the appropriate finalize choice
 *   3. Returns the resulting active escrow contract ID
 *
 * @module commands/finalize
 */

import type { Transport } from '../transport/base.js';
import type { Logger } from 'pino';
import type { FinalizeEscrowParams } from '../types/stream.js';
import { SettlementMode } from '../types/stream.js';
import {
  TEMPLATE_UTILITY_ACCEPTED_REQUEST,
  TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST,
  TEMPLATE_LOCAL_ASSET_ACCEPTED_REQUEST,
  CHOICE_FINALIZE_UTILITY_ESCROW,
  CHOICE_FINALIZE_TOKEN_STANDARD_ESCROW,
  CHOICE_FINALIZE_LOCAL_ASSET_ESCROW,
  assertTokenStandardEscrowAvailable,
} from '../templates.js';

/** Templates to search for accepted requests. */
const ACCEPTED_REQUEST_TEMPLATES = [
  { templateId: TEMPLATE_UTILITY_ACCEPTED_REQUEST, settlementMode: SettlementMode.UtilityHoldingCustody, choiceName: CHOICE_FINALIZE_UTILITY_ESCROW },
  { templateId: TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST, settlementMode: SettlementMode.TokenStandardCustody, choiceName: CHOICE_FINALIZE_TOKEN_STANDARD_ESCROW },
  { templateId: TEMPLATE_LOCAL_ASSET_ACCEPTED_REQUEST, settlementMode: SettlementMode.LocalAssetCustody, choiceName: CHOICE_FINALIZE_LOCAL_ASSET_ESCROW },
];

/**
 * Finalize custody for an accepted stream request.
 *
 * The escrow operator exercises the Finalize choice which:
 *   - Locks the source holding
 *   - Splits it into escrow + remainder
 *   - Creates the active custody-backed escrow
 *
 * Returns the resulting escrow contract ID.
 */
export async function finalizeEscrow(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  logger: Logger,
  acceptedRequestContractId?: string,
  settlementMode?: SettlementMode,
  params?: FinalizeEscrowParams,
): Promise<{ escrowContractId: string }> {
  logger.info({ sender, streamId }, 'Finalizing escrow custody');

  const finalizeArgsForMode = (mode: SettlementMode): Record<string, unknown> => {
    if (mode !== SettlementMode.TokenStandardCustody) {
      return {};
    }

    // [C1 fix — STR-103] Daml template missing; fail closed before submit.
    assertTokenStandardEscrowAvailable();

    if (!params?.escrowReference?.trim()) {
      throw new Error('escrowReference is required to finalize TokenStandardCustody streams');
    }
    if (!params?.settlementReference?.trim()) {
      throw new Error('settlementReference is required to finalize TokenStandardCustody streams');
    }
    if (!params.confirmedEscrowAmount) {
      throw new Error('confirmedEscrowAmount is required to finalize TokenStandardCustody streams');
    }

    return {
      escrowReference: { text: params.escrowReference.trim() },
      settlementReference: { text: params.settlementReference.trim() },
      confirmedEscrowAmount: { numeric: params.confirmedEscrowAmount.toString() },
    };
  };

  const targetTemplates =
    settlementMode == null
      ? ACCEPTED_REQUEST_TEMPLATES.filter((entry) => entry.settlementMode !== SettlementMode.TokenStandardCustody)
      : ACCEPTED_REQUEST_TEMPLATES.filter((entry) => entry.settlementMode === settlementMode);

  if (acceptedRequestContractId) {
    logger.info(
      { sender, streamId, contractId: acceptedRequestContractId },
      'Finalizing accepted request by explicit contract ID',
    );

    let lastError: unknown;
    for (const entry of targetTemplates) {
      const { templateId, settlementMode: entrySettlementMode, choiceName } = entry;
      try {
        const choiceArgs = finalizeArgsForMode(entrySettlementMode);
        const result = await transport.exercise<any>(
          templateId,
          acceptedRequestContractId,
          choiceName,
          choiceArgs,
          actAs,
        );

        const escrowContractId =
          typeof result === 'string'
            ? result
            : result?.contractId ?? result?.escrowContractId ?? acceptedRequestContractId;

        logger.info(
          { sender, streamId, escrowContractId, settlementMode: entrySettlementMode },
          'Custody finalized — escrow created',
        );

        return { escrowContractId };
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  let lastError: unknown;

  // Search for the accepted request contract
  for (const { templateId, settlementMode: entrySettlementMode, choiceName } of targetTemplates) {
    try {
      const results = await transport.query<any>(
        templateId,
        undefined,
        actAs,
        undefined,
      );

      for (const raw of results) {
        const config = raw.config ?? raw;
        if (config.sender === sender && config.streamId === streamId) {
          const contractId = raw.contractId ?? raw.contract_id ?? '';

          logger.info(
            { sender, streamId, contractId, settlementMode: entrySettlementMode },
            'Found accepted request — finalizing',
          );

          const choiceArgs = finalizeArgsForMode(entrySettlementMode);
          const result = await transport.exercise<any>(
            templateId,
            contractId,
            choiceName,
            choiceArgs,
            actAs,
          );

          const escrowContractId =
            typeof result === 'string'
              ? result
              : result?.contractId ?? result?.escrowContractId ?? contractId;

          logger.info(
            { sender, streamId, escrowContractId, settlementMode: entrySettlementMode },
            'Custody finalized — escrow created',
          );

          return { escrowContractId };
        }
      }
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`No accepted request found for finalization: sender=${sender}, streamId=${streamId}`);
}
