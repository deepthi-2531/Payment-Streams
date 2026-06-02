/**
 * @module settlement/adapter
 *
 * Legacy SettlementAdapter — deprecated pluggable token-transfer backend.
 *
 * Current stream settlement is V2 AllocationRequest / Allocation_Settle
 * through `settlement/allocation-dispatch.ts`. This interface remains for
 * old adapter code until the hard-delete cleanup lands.
 *
 * Each legacy adapter knew how to move tokens for a specific registrar/protocol:
 *   - TransferRuleAdapter: local tokens with a provider-owned TransferRule on ledger
 *   - TransferOfferAdapter: external tokens (CBTC etc.) via TransferOffer flow
 *
 * New code should not select adapters by registrar; it should use the
 * V2 capability gate and allocation dispatcher.
 */

import type { Logger } from 'pino';
import type { Transport } from '../transport/base.js';
import type Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Parameters for a single token transfer leg. */
export interface TransferParams {
  /** Party sending the tokens (must have holdings of this instrument). */
  readonly from: string;
  /** Party receiving the tokens. */
  readonly to: string;
  /** Amount to transfer. Must be > 0. */
  readonly amount: Decimal;
  /**
   * Full registrar party ID (e.g. "registrar-party::1220...").
   * Used to look up the TransferRule and InstrumentConfiguration.
   */
  readonly registrar: string;
  /**
   * Instrument ID string (e.g. the asset's ticker symbol).
   * Used together with registrar to identify the instrument.
   */
  readonly instrumentId: string;
  /** Human-readable reference / memo for this transfer leg. */
  readonly reference?: string;
}

/** Result of a completed token transfer. */
export interface TransferResult {
  /**
   * Settlement reference — an opaque string uniquely identifying this transfer.
   * For TransferRule transfers, this is the resulting holding contract ID.
   * For hosted TransferOffer / token-standard flows, this is the completed
   * receiver-accept settlement reference (for example a completion update ID).
   * Recorded on the TokenStandardEscrow contract for auditability.
   */
  readonly settlementReference: string;
  /** Amount actually transferred (should equal params.amount). */
  readonly amount: Decimal;
  /** Optional: the "change" holding CID returned to the sender after a split. */
  readonly senderChangeCid?: string;
  /** Optional: whether the receiver-side acceptance already completed. */
  readonly receiverAccepted?: boolean;
  /** Optional: pending transfer contract created for the receiver. */
  readonly pendingTransferContractId?: string;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/** Pluggable settlement adapter for a specific token protocol / registrar. */
export interface SettlementAdapter {
  /**
   * Return true if this adapter can move tokens for the given registrar.
   * The orchestrator calls this to pick the right adapter.
   *
   * @param registrar - Full registrar party ID
   * @param instrumentId - Instrument ID string
   */
  canHandle(registrar: string, instrumentId: string): Promise<boolean>;

  /**
   * Execute a token transfer and return a settlement reference.
   *
   * @param params   - Transfer parameters
   * @param actAs    - Parties that must co-authorize the ledger command
   * @param transport - gRPC transport
   * @param logger   - Logger
   */
  transfer(
    params: TransferParams,
    actAs: string[],
    transport: Transport,
    logger: Logger,
  ): Promise<TransferResult>;
}
