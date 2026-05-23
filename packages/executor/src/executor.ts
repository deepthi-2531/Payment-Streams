/**
 * Execution engine — exercises delegated choices on the ledger.
 *
 * For each PendingExecution:
 *   1. Look up the target escrow contract (to get its contract ID and settlement mode)
 *   2. Exercise ExecutePolicy on the DelegatedPolicy — this single exercise:
 *      a. Validates policy constraints (active, not expired, action allowed, etc.)
 *      b. Internally exercises the stream choice (withdraw/cancel) within the choice body
 *      c. Creates an ExecutionLog for audit
 *   3. If the exercise fails, call RecordFailedExecution to log the failure
 *
 * Authority model (non-custodial delegation):
 *   The DelegatedPolicy is signed by sender, recipient, and executor.
 *   The executor submits with actAs: [executor] ONLY. It does NOT
 *   impersonate sender or recipient. The ExecutePolicy choice body
 *   has the combined authority of all signatories (sender + recipient +
 *   executor), so it can exercise stream choices controlled by the
 *   recipient (Withdraw) or sender (Cancel) without the executor
 *   needing those parties in actAs.
 *
 *   For custody-backed streams, the escrowOperator is a signatory on the
 *   escrow contract. Since the escrowOperator is an observer on the
 *   DelegatedPolicy, the executor must also be allowed to read escrow
 *   contracts. The escrowOperator party is included in actAs to satisfy
 *   the escrow's signatory requirements during the nested exercise.
 *
 * Idempotency:
 *   Before executing, the evaluator checks if an ExecutionLog already
 *   exists for this (policyId, targetStreamId, recent time window).
 *   If it does, the execution is skipped.
 *
 * @module executor
 */

import type { Transport } from '@canton-streams/sdk';
import {
  TEMPLATE_DELEGATED_POLICY,
  CHOICE_EXECUTE_POLICY,
  ESCROW_TEMPLATES,
} from '@canton-streams/sdk';
import type { Logger } from 'pino';
import type { PendingExecution } from './evaluator.js';
import { findContractAcrossTemplates } from './lookup-helper.js';

export interface ExecutionResult {
  policyId: string;
  targetStreamId: string;
  action: string;
  success: boolean;
  error?: string;
}

/**
 * Execute a single pending action.
 *
 * The executor submits ONE exercise: ExecutePolicy on the DelegatedPolicy.
 * The choice body internally exercises the stream withdraw/cancel choice,
 * using the combined signatory authority of sender + recipient + executor.
 *
 * The executor submits with actAs: [executorParty, escrowOperatorParty].
 * It does NOT impersonate sender or recipient — their authority comes from
 * being signatories on the DelegatedPolicy template.
 */
export async function executeAction(
  transport: Transport,
  execution: PendingExecution,
  executorParty: string,
  escrowOperatorParty: string,
  logger: Logger,
): Promise<ExecutionResult> {
  const { policyContractId, policyId, targetStreamId, action, amount, sender } = execution;

  logger.info(
    { policyId, targetStreamId, action, amount: amount.toString() },
    'Executing delegated action',
  );

  // The executor submits as itself + escrowOperator (for custody escrow signatories).
  // It does NOT impersonate sender or recipient.
  const actAs = [...new Set([executorParty, escrowOperatorParty])];

  const now = new Date();
  const executionTimeMicros = (BigInt(now.getTime()) * 1000n).toString();

  try {
    // Look up the target escrow contract to get its contract ID and settlement mode.
    // This is a read-only query — no ledger state changes.
    const lookup = await findContractAcrossTemplates(
      transport,
      ESCROW_TEMPLATES,
      sender,
      targetStreamId,
      actAs,
    );

    // Map settlement mode string to the Daml enum tag
    const settlementModeTag = lookup.settlementMode ?? 'UtilityHoldingCustody';

    // Submit a SINGLE exercise: ExecutePolicy.
    // The choice body internally:
    //   1. Validates policy constraints
    //   2. Coerces targetEscrowCid to the correct escrow template type
    //   3. Exercises the stream choice (withdraw/cancel) using signatory authority
    //   4. Creates an ExecutionLog for audit
    //
    // This is ONE atomic Daml transaction. If the nested stream exercise fails,
    // the entire transaction rolls back.
    await transport.exercise(
      TEMPLATE_DELEGATED_POLICY,
      policyContractId,
      CHOICE_EXECUTE_POLICY,
      {
        executionTime: { timestamp: executionTimeMicros },
        targetStreamId: { text: targetStreamId },
        action: { tag: action, value: {} },
        amount: { numeric: amount.toString() },
        targetEscrowCid: { contractId: lookup.contractId },
        targetSettlementMode: { enum: { enum_constructor: settlementModeTag } },
      },
      actAs,
    );

    logger.info({ policyId, targetStreamId, action }, 'Delegated action executed successfully');
    return { policyId, targetStreamId, action, success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { policyId, targetStreamId, action, error: errorMsg },
      'Delegated action execution failed',
    );

    // Record the failure in the audit log (separate transaction — not atomic
    // with the failed exercise, since it already rolled back).
    try {
      await transport.exercise(
        TEMPLATE_DELEGATED_POLICY,
        policyContractId,
        'RecordFailedExecution',
        {
          executionTime: { timestamp: executionTimeMicros },
          targetStreamId: { text: targetStreamId },
          action: { tag: action, value: {} },
          amount: { numeric: amount.toString() },
          errorMsg: { text: errorMsg },
        },
        actAs,
      );
    } catch (logErr) {
      logger.warn(
        { policyId, targetStreamId, logErr },
        'Failed to record failed execution audit log',
      );
    }

    return { policyId, targetStreamId, action, success: false, error: errorMsg };
  }
}
