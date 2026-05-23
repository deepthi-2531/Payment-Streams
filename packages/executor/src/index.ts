/**
 * Canton Streams Delegated Executor Service — Phase 3.
 *
 * This service watches for active DelegatedPolicy contracts and
 * automatically executes delegated actions (withdrawals, etc.) on
 * behalf of stream senders, within policy rate limits.
 *
 * Architecture:
 *   1. Poll for active DelegatedPolicy contracts (watcher)
 *   2. Query real on-ledger stream balances for each policy's streams
 *   3. Evaluate each policy against actual balances (evaluator)
 *   4. Execute approved actions on the ledger (executor)
 *   5. Record executions in ExecutionLog for audit
 *
 * @module index
 */

import pino from 'pino';
import { loadConfig } from './config.js';
import { fetchActivePolicies, fetchRecentExecutions } from './watcher.js';
import { evaluatePolicy } from './evaluator.js';
import { executeAction } from './executor.js';
import { fetchStreamBalances } from './balance-query.js';
import { OffsetStore } from './offset.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const offsetStore = new OffsetStore(config.offsetStorePath);

/**
 * Main execution loop.
 *
 * In production, this uses the SDK's GrpcTransport.
 * The transport is injected to allow testing with mocks.
 */
async function runOnce(transport: any): Promise<void> {
  logger.debug('Starting execution cycle');

  try {
    // Step 1: Fetch active policies
    const policies = await fetchActivePolicies(transport, config.executorParty, logger);

    if (policies.length === 0) {
      logger.debug('No active policies found');
      return;
    }

    logger.info({ policyCount: policies.length }, 'Processing active policies');

    // Step 2: For each policy, evaluate and execute
    for (const policy of policies) {
      try {
        // Fetch recent executions for rate limiting + idempotency check
        const recentExecutions = await fetchRecentExecutions(
          transport,
          policy.policyId,
          config.executorParty,
          logger,
        );

        // Query REAL on-ledger stream balances.
        // The executor reads as itself + escrowOperator. It does NOT impersonate
        // sender/recipient for queries — the ACS query uses readAs visibility.
        const actAs = [...new Set([config.executorParty, policy.escrowOperator])];
        const streamBalances = await fetchStreamBalances(
          transport,
          policy,
          actAs,
          logger,
        );

        if (streamBalances.size === 0) {
          logger.debug({ policyId: policy.policyId }, 'No eligible streams with withdrawable balance');
          continue;
        }

        const pendingExecutions = evaluatePolicy(
          policy,
          recentExecutions,
          streamBalances,
          new Date(),
          logger,
        );

        // Step 3: Execute approved actions
        for (const execution of pendingExecutions) {
          // Idempotency check: skip if there's already a recent successful execution
          // for this exact (policyId, streamId) combination
          const alreadyExecuted = recentExecutions.some(
            (e) =>
              e.targetStreamId === execution.targetStreamId &&
              e.success &&
              (new Date().getTime() - e.executionTime.getTime()) < (policy.rateLimit.cooldownInterval / 1000),
          );

          if (alreadyExecuted) {
            logger.debug(
              { policyId: execution.policyId, streamId: execution.targetStreamId },
              'Skipping — recent successful execution exists (idempotency)',
            );
            continue;
          }

          const result = await executeAction(
            transport,
            execution,
            config.executorParty,
            policy.escrowOperator,
            logger,
          );
          if (!result.success) {
            logger.warn(
              { policyId: result.policyId, error: result.error },
              'Execution failed — will retry next cycle',
            );
          }
        }
      } catch (err) {
        logger.error(
          { policyId: policy.policyId, err },
          'Error processing policy — continuing with next',
        );
      }
    }

    // Update offset store after successful cycle
    await offsetStore.save(new Date().toISOString());
  } catch (err) {
    logger.error({ err }, 'Execution cycle failed');
  }
}

/**
 * Start the executor service with a polling loop.
 */
export async function start(transport: any): Promise<() => void> {
  logger.info(
    {
      executorParty: config.executorParty,
      pollIntervalMs: config.pollIntervalMs,
    },
    'Canton Streams Executor starting',
  );

  if (!config.executorParty) {
    throw new Error('EXECUTOR_PARTY environment variable must be set');
  }

  // Load last offset for resumability
  const lastOffset = await offsetStore.load();
  if (lastOffset) {
    logger.info({ lastOffset }, 'Resuming from saved offset');
  }

  let running = true;

  const loop = async () => {
    while (running) {
      await runOnce(transport);
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  };

  // Start the loop (non-blocking)
  loop().catch((err) => {
    logger.fatal({ err }, 'Executor loop crashed');
    process.exit(1);
  });

  // Return a stop function
  return () => {
    running = false;
    logger.info('Executor stopping');
  };
}

// CLI entry point
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  logger.info('Starting executor in standalone mode');
  logger.warn('Transport must be provided — standalone mode requires GrpcTransport setup');
  // In production: const transport = new GrpcTransport({ host, port, token });
  // start(transport);
}
