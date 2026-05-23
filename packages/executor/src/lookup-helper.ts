/**
 * Contract lookup helper for the executor service.
 *
 * Re-implements the core lookup logic since the SDK's internal
 * findContractAcrossTemplates is not exported for external use.
 *
 * @module lookup-helper
 */

import type { Transport, TemplateId } from '@canton-streams/sdk';

export interface LookupResult {
  contractId: string;
  templateId: TemplateId;
  settlementMode?: string;
}

/**
 * Search for a contract across multiple template types.
 * Returns the first match with its template metadata.
 */
export async function findContractAcrossTemplates(
  transport: Transport,
  templates: ReadonlyArray<{ readonly templateId: TemplateId; readonly settlementMode: any }>,
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

      for (const raw of results) {
        const config = raw.config ?? raw;
        if (config.sender === sender && config.streamId === streamId) {
          return {
            contractId: raw.contractId ?? raw.contract_id ?? '',
            templateId,
            settlementMode,
          };
        }
      }
    } catch {
      // Template might not be deployed; try next
      continue;
    }
  }

  throw new Error(`Contract not found: sender=${sender}, streamId=${streamId}`);
}
