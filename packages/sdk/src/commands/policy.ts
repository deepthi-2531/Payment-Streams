/**
 * Delegated policy management commands — Phase 3.
 *
 * Provides CRUD operations for DelegatedPolicy contracts:
 *   - listPolicies: query active policies
 *   - createPolicyProposal: sender proposes a new delegation
 *   - revokePolicy: sender disables a policy
 *   - listExecutionLogs: query execution audit trail
 *
 * @module commands/policy
 */

import type { Transport } from '../transport/base.js';
import type { Logger } from 'pino';
import {
  TEMPLATE_DELEGATED_POLICY,
  TEMPLATE_EXECUTION_LOG,
  CHOICE_REVOKE_POLICY,
} from '../templates.js';
import { LedgerError } from '../utils/errors.js';

/** Policy contract as returned by queries. */
export interface PolicyInfo {
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
  expiresAt: string;
  createdAt: string;
}

/** Execution log entry as returned by queries. */
export interface ExecutionLogInfo {
  contractId: string;
  policyId: string;
  executionId: string;
  sender: string;
  executor: string;
  targetStreamId: string;
  action: string;
  amount: string;
  executionTime: string;
  success: boolean;
  errorMessage?: string;
}

/**
 * List all delegated policies visible to the acting parties.
 */
export async function listPolicies(
  transport: Transport,
  actAs: string[],
  readAs: string[] | undefined,
  logger: Logger,
): Promise<PolicyInfo[]> {
  logger.debug('Listing delegated policies');

  let results: any[];
  try {
    results = await transport.query<any>(
      TEMPLATE_DELEGATED_POLICY,
      undefined,
      actAs,
      readAs,
    );
  } catch (err) {
    if (isMissingPolicyTemplateError(err)) {
      logger.warn({ err }, 'DelegatedPolicy template is not deployed on this participant');
      return [];
    }
    throw err;
  }

  return results.map(deserializePolicy);
}

/**
 * Revoke a delegated policy (sender only).
 */
export async function revokePolicy(
  transport: Transport,
  policyContractId: string,
  actAs: string[],
  logger: Logger,
): Promise<{ newContractId: string }> {
  logger.info({ policyContractId }, 'Revoking delegated policy');

  const result = await transport.exercise<any>(
    TEMPLATE_DELEGATED_POLICY,
    policyContractId,
    CHOICE_REVOKE_POLICY,
    {},
    actAs,
  );

  const newContractId = typeof result === 'string' ? result : result?.contractId ?? '';
  logger.info({ policyContractId, newContractId }, 'Policy revoked');

  return { newContractId };
}

/**
 * List execution logs, optionally filtered by policyId.
 */
export async function listExecutionLogs(
  transport: Transport,
  policyId: string | undefined,
  actAs: string[],
  readAs: string[] | undefined,
  logger: Logger,
): Promise<ExecutionLogInfo[]> {
  logger.debug({ policyId }, 'Listing execution logs');

  let results: any[];
  try {
    results = await transport.query<any>(
      TEMPLATE_EXECUTION_LOG,
      undefined,
      actAs,
      readAs,
    );
  } catch (err) {
    if (isMissingPolicyTemplateError(err)) {
      logger.warn({ err }, 'ExecutionLog template is not deployed on this participant');
      return [];
    }
    throw err;
  }

  let logs = results.map(deserializeExecutionLog);
  if (policyId) {
    logs = logs.filter((l) => l.policyId === policyId);
  }

  return logs;
}

function deserializePolicy(raw: any): PolicyInfo {
  return {
    contractId: raw.contractId ?? raw.contract_id ?? '',
    policyId: raw.policyId ?? '',
    sender: raw.sender ?? '',
    recipient: raw.recipient ?? '',
    executor: raw.executor ?? '',
    escrowOperator: raw.escrowOperator ?? '',
    allowedActions: Array.isArray(raw.allowedActions)
      ? raw.allowedActions.map((a: any) => (typeof a === 'string' ? a : a?.tag ?? a?.variant_constructor ?? ''))
      : [],
    rateLimit: {
      maxExecutionsPerPeriod: Number(raw.rateLimit?.maxExecutionsPerPeriod ?? 0),
      periodDuration: Number(raw.rateLimit?.periodDuration ?? 0),
      maxAmountPerExecution: String(raw.rateLimit?.maxAmountPerExecution ?? '0'),
      cooldownInterval: Number(raw.rateLimit?.cooldownInterval ?? 0),
    },
    streamFilters: Array.isArray(raw.streamFilters) ? raw.streamFilters : [],
    active: raw.active ?? false,
    expiresAt: raw.expiresAt ?? '',
    createdAt: raw.createdAt ?? '',
  };
}

function deserializeExecutionLog(raw: any): ExecutionLogInfo {
  return {
    contractId: raw.contractId ?? raw.contract_id ?? '',
    policyId: raw.policyId ?? '',
    executionId: raw.executionId ?? '',
    sender: raw.sender ?? '',
    executor: raw.executor ?? '',
    targetStreamId: raw.targetStreamId ?? '',
    action: typeof raw.action === 'string' ? raw.action : raw.action?.tag ?? '',
    amount: String(raw.amount ?? '0'),
    executionTime: raw.executionTime ?? '',
    success: raw.success ?? false,
    errorMessage: raw.errorMessage?.tag === 'Some' ? raw.errorMessage.value : raw.errorMessage ?? undefined,
  };
}

function isMissingPolicyTemplateError(err: unknown): boolean {
  if (err instanceof LedgerError) {
    return err.grpcMessage?.includes('TEMPLATES_OR_INTERFACES_NOT_FOUND') === true;
  }

  if (err instanceof Error) {
    return err.message.includes('TEMPLATES_OR_INTERFACES_NOT_FOUND');
  }

  return false;
}
