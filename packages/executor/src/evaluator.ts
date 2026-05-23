/**
 * Execution evaluator — decides when to execute delegated actions.
 *
 * For each active policy, the evaluator:
 *   1. Checks rate limits against recent execution logs
 *   2. Checks cooldown intervals
 *   3. Queries associated streams for withdrawable amounts
 *   4. Returns a list of actions to execute
 *
 * @module evaluator
 */

import Decimal from 'decimal.js';
import type { PolicyContract, ExecutionLogContract } from './watcher.js';
import type { Logger } from 'pino';

/** An action the executor should take. */
export interface PendingExecution {
  policyContractId: string;
  policyId: string;
  targetStreamId: string;
  action: string;
  amount: Decimal;
  sender: string;
  recipient: string;
}

/**
 * Evaluate a policy against its streams and execution history.
 *
 * Returns a list of pending executions that should be performed.
 */
export function evaluatePolicy(
  policy: PolicyContract,
  recentExecutions: ExecutionLogContract[],
  streamBalances: Map<string, { withdrawable: Decimal; streamId: string }>,
  now: Date,
  logger: Logger,
): PendingExecution[] {
  const pending: PendingExecution[] = [];

  // Check if policy is rate-limited
  const periodStart = new Date(now.getTime() - policy.rateLimit.periodDuration / 1000);
  const executionsInPeriod = recentExecutions.filter(
    (e) => e.executionTime > periodStart,
  );

  if (executionsInPeriod.length >= policy.rateLimit.maxExecutionsPerPeriod) {
    logger.debug(
      { policyId: policy.policyId, executionsInPeriod: executionsInPeriod.length },
      'Policy rate-limited — skipping',
    );
    return [];
  }

  // Check cooldown
  const lastExecution = recentExecutions
    .sort((a, b) => b.executionTime.getTime() - a.executionTime.getTime())[0];

  if (lastExecution) {
    const cooldownEnd = new Date(
      lastExecution.executionTime.getTime() + policy.rateLimit.cooldownInterval / 1000,
    );
    if (now < cooldownEnd) {
      logger.debug(
        { policyId: policy.policyId, cooldownEnd },
        'Policy in cooldown — skipping',
      );
      return [];
    }
  }

  // Check each eligible stream
  const maxAmount = new Decimal(policy.rateLimit.maxAmountPerExecution);
  const remainingExecutions = policy.rateLimit.maxExecutionsPerPeriod - executionsInPeriod.length;

  for (const [streamId, balance] of streamBalances.entries()) {
    // Stream filter check
    if (policy.streamFilters.length > 0 && !policy.streamFilters.includes(streamId)) {
      continue;
    }

    if (remainingExecutions <= pending.length) break;

    // For withdrawal: check if there's a withdrawable amount
    if (policy.allowedActions.includes('DelegateWithdraw') && balance.withdrawable.greaterThan(0)) {
      const amount = Decimal.min(balance.withdrawable, maxAmount);
      pending.push({
        policyContractId: policy.contractId,
        policyId: policy.policyId,
        targetStreamId: streamId,
        action: 'DelegateWithdraw',
        amount,
        sender: policy.sender,
        recipient: policy.recipient,
      });
    }
  }

  return pending;
}
