/**
 * Stream acceptance command.
 *
 * Dispatches to the correct template based on settlement mode:
 * - NumericLegacy: AcceptStream on CreateStreamRequest
 * - UtilityHoldingCustody: AcceptUtilityHoldingRequest on CreateUtilityHoldingStreamRequest
 * - TokenStandardCustody: AcceptTokenStandardRequest on CreateTokenStandardStreamRequest
 *
 * For custody-backed streams, acceptance creates an intermediate
 * AcceptedUtilityHoldingRequest. The escrow operator then finalizes
 * custody in a separate step (via the proxy finalize route).
 *
 * Since LF 2.x (Daml SDK 3.4+) does not support contract keys,
 * we first look up the contract ID via ACS query, then exercise by ID.
 *
 * @module commands/accept
 */

import type { Transport } from '../transport/base.js';
import type { Logger } from 'pino';
import { findContractAcrossTemplates } from './lookup.js';
import { SettlementMode } from '../types/stream.js';
import {
  CHOICE_ACCEPT_STREAM,
  CHOICE_ACCEPT_UTILITY_REQUEST,
  CHOICE_ACCEPT_TOKEN_STANDARD_REQUEST,
  CHOICE_ACCEPT_LOCAL_ASSET_REQUEST,
  CREATE_REQUEST_TEMPLATES,
} from '../templates.js';

/**
 * Accept a pending stream creation request.
 *
 * Auto-detects the settlement mode by looking up the contract across
 * all create-request template types.
 *
 * For numeric streams: creates StreamEscrow directly.
 * For utility custody: creates AcceptedUtilityHoldingRequest (service finalizes).
 *
 * Returns the resulting contract ID.
 */
export async function acceptStream(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  logger: Logger,
): Promise<{ escrowContractId: string }> {
  logger.info({ sender, streamId }, 'Accepting stream request');

  // Auto-detect which template the request is on
  const lookup = await findContractAcrossTemplates(
    transport,
    CREATE_REQUEST_TEMPLATES,
    sender,
    streamId,
    actAs,
  );

  let choiceName: string;
  switch (lookup.settlementMode) {
    case SettlementMode.UtilityHoldingCustody:
      choiceName = CHOICE_ACCEPT_UTILITY_REQUEST;
      break;
    case SettlementMode.TokenStandardCustody:
      choiceName = CHOICE_ACCEPT_TOKEN_STANDARD_REQUEST;
      break;
    case SettlementMode.LocalAssetCustody:
      choiceName = CHOICE_ACCEPT_LOCAL_ASSET_REQUEST;
      break;
    case SettlementMode.NumericLegacy:
    default:
      choiceName = CHOICE_ACCEPT_STREAM;
      break;
  }

  const result = await transport.exercise<any>(
    lookup.templateId,
    lookup.contractId,
    choiceName,
    {},
    actAs,
  );

  const escrowContractId =
    typeof result === 'string'
      ? result
      : result?.contractId ?? result?.escrowContractId ?? lookup.contractId;

  const label = lookup.settlementMode === SettlementMode.UtilityHoldingCustody
    ? 'Stream accepted — AcceptedUtilityHoldingRequest created (awaiting custody finalization)'
    : lookup.settlementMode === SettlementMode.TokenStandardCustody
      ? 'Stream accepted — AcceptedTokenStandardStreamRequest created (awaiting confirmed external funding)'
    : lookup.settlementMode === SettlementMode.LocalAssetCustody
      ? 'Stream accepted — AcceptedLocalAssetRequest created (awaiting custody finalization)'
      : 'Stream accepted — StreamEscrow created';

  logger.info(
    { sender, streamId, escrowContractId, settlementMode: lookup.settlementMode },
    label,
  );

  return { escrowContractId };
}
