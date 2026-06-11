/**
 * ACS watcher for DelegatedPolicy contracts.
 *
 * Polls the ledger for active DelegatedPolicy contracts visible to
 * the executor party. Returns only policies that are:
 *   - Active (active = True)
 *   - Not expired (expiresAt > now)
 *   - Grant permissions to this executor party
 *
 * @module watcher
 */

import type { Transport } from '@canton-streams/sdk';
import { TEMPLATE_DELEGATED_POLICY, TEMPLATE_EXECUTION_LOG } from '@canton-streams/sdk';
import type { Logger } from 'pino';

/** Raw policy contract from ACS query. */
export interface PolicyContract {
  contractId: string;
  policyId: string;
  sender: string;
  recipient: string;
  executor: string;
  escrowOperator: string;
  allowedActions: string[];
  rateLimit: {
    maxExecutionsPerPeriod: number;
    periodDuration: number;
    maxAmountPerExecution: string;
    cooldownInterval: number;
  };
  streamFilters: string[];
  active: boolean;
  expiresAt: Date;
  createdAt: Date;
}

/** Raw execution log from ACS query. */
export interface ExecutionLogContract {
  contractId: string;
  policyId: string;
  executionId: string;
  targetStreamId: string;
  action: string;
  amount: string;
  executionTime: Date;
  success: boolean;
}

/**
 * Fetch all active policies for this executor.
 */
export async function fetchActivePolicies(
  transport: Transport,
  executorParty: string,
  logger: Logger,
): Promise<PolicyContract[]> {
  logger.debug('Fetching active policies');

  const results = await transport.query<any>(
    TEMPLATE_DELEGATED_POLICY,
    undefined,
    [executorParty],
    undefined,
  );

  const now = new Date();
  const policies: PolicyContract[] = [];

  for (const raw of results) {
    try {
      const policy = deserializePolicy(raw);
      if (policy.active && policy.executor === executorParty && policy.expiresAt > now) {
        policies.push(policy);
      }
    } catch (err) {
      logger.warn({ contractId: raw.contractId, err }, 'Failed to deserialize policy');
    }
  }

  logger.debug({ count: policies.length }, 'Active policies fetched');
  return policies;
}

/** Hard cap on retained logs per policy, regardless of window size. */
const MAX_RETAINED_LOGS = 256;

/**
 * Fetch recent execution logs for a policy.
 *
 * The full ExecutionLog ACS is never archived, so scanning all of it every
 * cycle is O(policies × totalLogs) and can be inflated by failed-execution
 * logs. We only need logs within the policy's own rate-limit window for the
 * idempotency / rate / cooldown checks, so we bound the working set:
 *   - filter server-side by policyId where the transport supports a payload
 *     query (template-only transports ignore the filter and we bound below);
 *   - drop anything older than the relevant window in memory;
 *   - cap the retained count so a transport returning the whole template set
 *     cannot grow the per-cycle working set without bound.
 */
export async function fetchRecentExecutions(
  transport: Transport,
  policy: Pick<PolicyContract, 'policyId' | 'rateLimit'>,
  executorParty: string,
  _logger: Logger,
  now: Date = new Date(),
): Promise<ExecutionLogContract[]> {
  const { policyId, rateLimit } = policy;

  // Window must cover whichever of period/cooldown the checks look back over.
  // periodDuration/cooldownInterval are stored in microseconds.
  const windowMicros = Math.max(rateLimit.periodDuration, rateLimit.cooldownInterval, 0);
  const cutoff = new Date(now.getTime() - windowMicros / 1000);

  const results = await transport.query<any>(
    TEMPLATE_EXECUTION_LOG,
    { policyId },
    [executorParty],
    undefined,
  );

  return results
    .filter((raw: any) => raw.policyId === policyId)
    .map(deserializeExecutionLog)
    .filter((log) => log.executionTime > cutoff)
    .sort((a, b) => b.executionTime.getTime() - a.executionTime.getTime())
    .slice(0, MAX_RETAINED_LOGS);
}

function deserializePolicy(raw: any): PolicyContract {
  return {
    contractId: raw.contractId ?? raw.contract_id ?? '',
    policyId: raw.policyId ?? '',
    sender: raw.sender ?? '',
    recipient: raw.recipient ?? '',
    executor: raw.executor ?? '',
    escrowOperator: raw.escrowOperator ?? '',
    allowedActions: Array.isArray(raw.allowedActions) ? raw.allowedActions.map(deserializeAction) : [],
    rateLimit: {
      maxExecutionsPerPeriod: Number(raw.rateLimit?.maxExecutionsPerPeriod ?? 0),
      periodDuration: Number(raw.rateLimit?.periodDuration ?? 0),
      maxAmountPerExecution: String(raw.rateLimit?.maxAmountPerExecution ?? '0'),
      cooldownInterval: Number(raw.rateLimit?.cooldownInterval ?? 0),
    },
    streamFilters: Array.isArray(raw.streamFilters) ? raw.streamFilters : [],
    active: raw.active ?? false,
    expiresAt: new Date(raw.expiresAt ?? 0),
    createdAt: new Date(raw.createdAt ?? 0),
  };
}

function deserializeExecutionLog(raw: any): ExecutionLogContract {
  return {
    contractId: raw.contractId ?? raw.contract_id ?? '',
    policyId: raw.policyId ?? '',
    executionId: raw.executionId ?? '',
    targetStreamId: raw.targetStreamId ?? '',
    action: deserializeAction(raw.action),
    amount: String(raw.amount ?? '0'),
    executionTime: new Date(raw.executionTime ?? 0),
    success: raw.success ?? false,
  };
}

function deserializeAction(raw: any): string {
  if (typeof raw === 'string') return raw;
  return raw?.tag ?? raw?.variant_constructor ?? 'DelegateWithdraw';
}
