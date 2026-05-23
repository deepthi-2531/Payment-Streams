/**
 * Real on-ledger balance queries for the executor.
 *
 * Queries escrow contracts and computes withdrawable amounts using
 * the SDK's accrual calculator. No synthetic/placeholder balances.
 *
 * @module balance-query
 */

import type { Transport } from '@canton-streams/sdk';
import { ESCROW_TEMPLATES, getBalances } from '@canton-streams/sdk';
import type { PolicyContract } from './watcher.js';
import type { Logger } from 'pino';
import Decimal from 'decimal.js';

interface StreamBalance {
  withdrawable: Decimal;
  streamId: string;
}

/**
 * Query real escrow contracts for a policy's streams and compute withdrawable amounts.
 *
 * For each escrow template type, queries the ACS for contracts matching the
 * policy's sender, then filters by stream ID (if policy has streamFilters),
 * and computes the withdrawable balance using the SDK's accrual calculator.
 */
export async function fetchStreamBalances(
  transport: Transport,
  policy: PolicyContract,
  actAs: string[],
  logger: Logger,
): Promise<Map<string, StreamBalance>> {
  const balances = new Map<string, StreamBalance>();
  const now = new Date();

  for (const { templateId, settlementMode } of ESCROW_TEMPLATES) {
    try {
      const results = await transport.query<any>(
        templateId,
        undefined,
        actAs,
        undefined,
      );

      for (const raw of results) {
        try {
          const config = raw.config ?? raw;
          const state = raw.state ?? {};
          const streamId = config.streamId;

          // Must be sender's stream
          if (config.sender !== policy.sender) continue;

          // Must be recipient's stream
          if (config.recipient !== policy.recipient) continue;

          // Stream filter check (empty = all streams)
          if (policy.streamFilters.length > 0 && !policy.streamFilters.includes(streamId)) continue;

          // Only active streams
          if ((state.status ?? 'Active') !== 'Active') continue;

          // Compute real withdrawable balance using the accrual calculator
          const totalDeposited = new Decimal(config.totalDeposited ?? '0');
          const totalWithdrawn = new Decimal(state.totalWithdrawn ?? '0');
          const startTime = parseTime(config.startTime);
          const endTime = parseTime(config.endTime);

          if (!startTime || !endTime || now < startTime) continue;

          // Simple linear accrual computation for the executor
          // (the full SDK calculator handles all vesting modes, but for the
          // executor we need a quick calculation)
          const streamBalances = getBalances(
            {
              config: {
                streamId,
                sender: config.sender,
                recipient: config.recipient,
                totalDeposited,
                startTime,
                endTime,
                vestingMode: { mode: config.vestingMode?.tag ?? 'Linear' } as any,
                assetType: config.assetType ?? 'GlobalCip56',
                cancellable: config.cancellable ?? true,
                settlementMode,
              },
              state: {
                totalWithdrawn,
                status: state.status ?? 'Active',
                lastWithdrawTime: state.lastWithdrawTime ? parseTime(state.lastWithdrawTime) : undefined,
                renewalCount: Number(state.renewalCount ?? 0),
              },
              contractId: raw.contractId ?? '',
            },
            now,
          );

          if (streamBalances && streamBalances.withdrawable.greaterThan(0)) {
            balances.set(streamId, {
              withdrawable: streamBalances.withdrawable,
              streamId,
            });
          }
        } catch (err) {
          logger.warn({ contractId: raw.contractId, err }, 'Failed to compute balance for stream');
        }
      }
    } catch {
      // Template might not be deployed; skip
      continue;
    }
  }

  logger.debug(
    { policyId: policy.policyId, streamCount: balances.size },
    'Fetched real stream balances',
  );

  return balances;
}

function parseTime(raw: any): Date | undefined {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) {
      return new Date(Number(BigInt(raw) / 1000n));
    }
    return new Date(raw);
  }
  if (typeof raw === 'object' && raw !== null && 'seconds' in raw) {
    const seconds = typeof raw.seconds === 'string' ? BigInt(raw.seconds) : BigInt(raw.seconds);
    const nanos = raw.nanos ?? 0;
    return new Date(Number(seconds * 1000n) + Math.floor(nanos / 1_000_000));
  }
  if (typeof raw === 'number') return new Date(raw);
  return undefined;
}
