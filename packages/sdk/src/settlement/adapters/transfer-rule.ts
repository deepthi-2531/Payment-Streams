/**
 * @module settlement/adapters/transfer-rule
 *
 * TransferRuleAdapter — settlement via Utility.Registry.V0.Rule.Transfer.TransferRule.
 *
 * Handles token transfers for instruments where the registrar has published a
 * TransferRule on this participant (typically local / provider-owned tokens).
 *
 * TransferRule_Transfer internally collapses the sender's Holdings (split/merge)
 * and creates a new Holding for the receiver — all authorized by the TransferRule's
 * registrar signatory, without requiring an external network party.
 *
 * Environment:
 *   CANTON_STREAMS_TRANSFER_RULE_PACKAGE_ID  — package that contains TransferRule
 *                                               (default: ed73d5b9ab717333...)
 */

import type { Logger } from 'pino';
import type { Transport } from '../../transport/base.js';
import type { SettlementAdapter, TransferParams, TransferResult } from '../adapter.js';

// ---------------------------------------------------------------------------
// Package / template constants
// ---------------------------------------------------------------------------

const TRANSFER_RULE_PACKAGE_ID: string =
  process.env['CANTON_STREAMS_TRANSFER_RULE_PACKAGE_ID'] ??
  'ed73d5b9ab717333f3dbd122de7be3156f8bf2614a67360c3dd61fc0135133fa';

const INSTRUMENT_CONFIG_PACKAGE_ID: string =
  process.env['CANTON_STREAMS_INSTRUMENT_CONFIG_PACKAGE_ID'] ?? TRANSFER_RULE_PACKAGE_ID;

// Module + entity names
const TRANSFER_RULE_MODULE = 'Utility.Registry.V0.Rule.Transfer';
const TRANSFER_RULE_ENTITY = 'TransferRule';
const INSTRUMENT_CONFIG_MODULE = 'Utility.Registry.V0.Configuration.Instrument';
const INSTRUMENT_CONFIG_ENTITY = 'InstrumentConfiguration';

const TRANSFER_RULE_TEMPLATE_ID = {
  packageId: TRANSFER_RULE_PACKAGE_ID,
  moduleName: TRANSFER_RULE_MODULE,
  entityName: TRANSFER_RULE_ENTITY,
};

const INSTRUMENT_CONFIG_TEMPLATE_ID = {
  packageId: INSTRUMENT_CONFIG_PACKAGE_ID,
  moduleName: INSTRUMENT_CONFIG_MODULE,
  entityName: INSTRUMENT_CONFIG_ENTITY,
};

// ---------------------------------------------------------------------------
// TransferRuleAdapter
// ---------------------------------------------------------------------------

/**
 * @deprecated The settlement-reference path is replaced by V2
 * AllocationRequest. Use `dispatchSettlement` from
 * `settlement/allocation-dispatch.ts`.
 */
export class TransferRuleAdapter implements SettlementAdapter {
  /**
   * Can handle any registrar for which a TransferRule is visible to actAs parties.
   * The check is deferred to transfer() since it requires a live ledger query.
   * canHandle() does a static check: if the registrar matches the known local
   * validators. We return true optimistically and fail fast at transfer time
   * if no TransferRule is found.
   */
  async canHandle(_registrar: string, _instrumentId: string): Promise<boolean> {
    // Optimistic: return true and fail fast at transfer() if no rule is found.
    // A negative check would require a ledger round-trip per-request.
    return true;
  }

  async transfer(
    params: TransferParams,
    actAs: string[],
    transport: Transport,
    logger: Logger,
  ): Promise<TransferResult> {
    logger.info(
      {
        from: params.from.split('::')[0],
        to: params.to.split('::')[0],
        amount: params.amount.toString(),
        instrumentId: params.instrumentId,
      },
      'TransferRuleAdapter: executing TransferRule_Transfer',
    );

    // 1. Find the TransferRule for this registrar
    const transferRuleCid = await this.findTransferRule(transport, params.registrar, actAs, logger);

    // 2. Find the InstrumentConfiguration for this registrar + instrument
    const { instrumentConfigCid, operator, provider, instrumentIdentifier } =
      await this.findInstrumentConfig(
        transport,
        params.registrar,
        params.instrumentId,
        actAs,
        logger,
      );

    // 3. Build the transfer reference
    const reference = params.reference ?? `streams-${Date.now()}`;

    // 4. Exercise TransferRule_Transfer
    //    The choice internally finds the sender's Holdings, splits/merges, and
    //    creates a new Holding for the receiver. No explicit holding CID needed.
    const choiceArgs = {
      transfer: {
        operator: { party: operator },
        provider: { party: provider },
        registrar: { party: params.registrar },
        sender: { party: params.from },
        receiver: { party: params.to },
        amount: { numeric: params.amount.toFixed(10) },
        instrumentIdentifier,
        reference,
        batch: { optional: null },
      },
      senderCredentialCids: [],
      receiverCredentialCids: [],
      featuredAppRightCid: { optional: null },
      appRewardConfigurationCid: { optional: null },
      instrumentConfigurationCid: { contract_id: instrumentConfigCid },
    };

    logger.debug(
      {
        transferRuleCid: transferRuleCid.slice(0, 20),
        instrumentConfigCid: instrumentConfigCid.slice(0, 20),
      },
      'TransferRuleAdapter: submitting exercise',
    );

    const result = await transport.exercise<any>(
      TRANSFER_RULE_TEMPLATE_ID,
      transferRuleCid,
      'TransferRule_Transfer',
      choiceArgs,
      actAs,
    );

    // Result: { senderChangeCid: Optional ContractId, receiverHoldingCid: ContractId }
    const receiverHoldingCid: string =
      result?.receiverHoldingCid ?? result?.receiver_holding_cid ?? '';
    const senderChangeCid: string | undefined =
      result?.senderChangeCid ?? result?.sender_change_cid ?? undefined;

    if (!receiverHoldingCid) {
      throw new Error(
        `TransferRule_Transfer succeeded but returned no receiverHoldingCid. Result: ${JSON.stringify(result)}`,
      );
    }

    logger.info(
      {
        receiverHoldingCid: receiverHoldingCid.slice(0, 20),
        senderChangeCid: senderChangeCid?.slice(0, 20),
      },
      'TransferRuleAdapter: transfer complete',
    );

    return {
      settlementReference: receiverHoldingCid,
      amount: params.amount,
      senderChangeCid,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async findTransferRule(
    transport: Transport,
    registrar: string,
    actAs: string[],
    logger: Logger,
  ): Promise<string> {
    const results = await transport.query<any>(
      TRANSFER_RULE_TEMPLATE_ID,
      undefined,
      actAs,
      undefined,
    );

    const match = results.find((r: any) => {
      const reg = r.registrar ?? r.fields?.registrar;
      return reg === registrar;
    });

    if (!match) {
      throw new Error(
        `No TransferRule found for registrar ${registrar.split('::')[0]}. ` +
          `The registrar must publish a TransferRule on this participant to enable ` +
          `TokenStandardCustody settlement. Contact the token issuer to request one.`,
      );
    }

    const cid = match.contractId ?? match.contract_id ?? '';
    logger.debug(
      { registrar: registrar.split('::')[0], cid: cid.slice(0, 20) },
      'Found TransferRule',
    );
    return cid;
  }

  private async findInstrumentConfig(
    transport: Transport,
    registrar: string,
    instrumentId: string,
    actAs: string[],
    logger: Logger,
  ): Promise<{
    instrumentConfigCid: string;
    operator: string;
    provider: string;
    instrumentIdentifier: unknown;
  }> {
    const results = await transport.query<any>(
      INSTRUMENT_CONFIG_TEMPLATE_ID,
      undefined,
      actAs,
      undefined,
    );

    const match = results.find((r: any) => {
      const reg = r.registrar ?? '';
      // The defaultIdentifier has {source, id, scheme}; source = registrar party
      const defId = r.defaultIdentifier ?? r.default_identifier ?? {};
      const id = defId.id ?? '';
      return reg === registrar && id === instrumentId;
    });

    if (!match) {
      throw new Error(
        `No InstrumentConfiguration found for registrar=${registrar.split('::')[0]}, instrumentId=${instrumentId}. ` +
          `The registrar must publish an InstrumentConfiguration for this instrument.`,
      );
    }

    const cid = match.contractId ?? match.contract_id ?? '';
    const operator: string = match.operator ?? '';
    const provider: string = match.provider ?? '';
    const defId = match.defaultIdentifier ?? match.default_identifier ?? {};

    // Build the InstrumentIdentifier value in the tagged wire format the gRPC
    // transport expects. The ledger type is:
    //   InstrumentIdentifier { source: Party, id: Text, scheme: Text }
    const instrumentIdentifier = {
      source: { party: defId.source ?? registrar },
      id: defId.id ?? instrumentId,
      scheme: defId.scheme ?? 'RegistrarInternalScheme',
    };

    logger.debug(
      { registrar: registrar.split('::')[0], instrumentId, cid: cid.slice(0, 20) },
      'Found InstrumentConfiguration',
    );

    return { instrumentConfigCid: cid, operator, provider, instrumentIdentifier };
  }
}
