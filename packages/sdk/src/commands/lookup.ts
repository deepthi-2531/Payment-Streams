/**
 * Contract ID lookup helper.
 *
 * LF 2.x (Daml SDK 3.4+) removed contract key support.
 * All exercise commands must use contract IDs instead of keys.
 * This module provides a lookup that queries the ACS to find
 * the contract ID for a given (sender, streamId) pair.
 *
 * @module commands/lookup
 */

import type { Transport, TemplateId } from '../transport/base.js';
import type { SettlementMode } from '../types/stream.js';

/**
 * Result of a multi-template contract lookup.
 * Includes which template matched, allowing the caller to determine
 * which choice names and settlement path to use.
 */
export interface LookupResult {
  /** The contract ID found on-ledger. */
  contractId: string;
  /** Which template the contract matched against. */
  templateId: TemplateId;
  /** Settlement mode associated with the matched template (if tagged). */
  settlementMode?: SettlementMode;
}

/**
 * Find the contract ID for a StreamEscrow identified by (sender, streamId).
 *
 * Queries the Active Contract Set and searches for a matching contract.
 * Throws if no matching contract is found.
 */
export async function findContractId(
  transport: Transport,
  templateId: TemplateId,
  sender: string,
  streamId: string,
  actAs: string[],
): Promise<string> {
  const results = await transport.query<any>(
    templateId,
    undefined,
    actAs,
    undefined,
  );

  const match = results.find((c: any) => {
    const config = c.config ?? c;
    return config?.sender === sender && config?.streamId === streamId;
  });

  if (!match) {
    throw new Error(`Stream contract not found: sender=${sender}, streamId=${streamId}`);
  }

  const contractId = match.contractId ?? match.contract_id;
  if (!contractId) {
    throw new Error(`Contract found but no contract ID: sender=${sender}, streamId=${streamId}`);
  }

  return contractId;
}

/**
 * Find a contract across multiple template types.
 *
 * Queries each template in order and returns the first match.
 * This is used by withdraw/cancel/renew to auto-detect which
 * settlement mode (and therefore which template/choice) to use.
 *
 * @param templates - Array of { templateId, settlementMode } pairs to search
 * @returns LookupResult with contractId, matched templateId, and settlementMode
 * @throws Error if no matching contract is found in any template
 */
export async function findContractAcrossTemplates(
  transport: Transport,
  templates: ReadonlyArray<{ readonly templateId: TemplateId; readonly settlementMode: SettlementMode }>,
  sender: string,
  streamId: string,
  actAs: string[],
): Promise<LookupResult> {
  for (const { templateId, settlementMode } of templates) {
    try {
      const results = await transport.query<any>(
        templateId,
        undefined,
        actAs,
        undefined,
      );

      const match = results.find((c: any) => {
        const config = c.config ?? c;
        return config?.sender === sender && config?.streamId === streamId;
      });

      if (match) {
        const contractId = match.contractId ?? match.contract_id;
        if (contractId) {
          return { contractId, templateId, settlementMode };
        }
      }
    } catch {
      // Template might not be deployed yet; try next one
      continue;
    }
  }

  throw new Error(
    `Stream contract not found in any template: sender=${sender}, streamId=${streamId}`,
  );
}
