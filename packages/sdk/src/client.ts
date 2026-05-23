/**
 * CantonStreamsClient — main entry point for the SDK.
 *
 * Provides a high-level API for creating, querying, and managing
 * payment streams on Canton via gRPC Ledger API.
 *
 * @module client
 */

import type { ClientConfig } from './types/config.js';
import type {
  Stream,
  StreamBalances,
  CreateStreamParams,
  CreateBatchParams,
  FinalizeEscrowParams,
  TokenStandardWithdrawParams,
  TokenStandardCancelParams,
  WithdrawResult,
  CancelResult,
  RenewParams,
  StreamFilter,
  StreamEvent,
  StreamUpdate,
  PendingStreamRequest,
  PendingStreamRequestFilter,
  SettlementMode,
} from './types/stream.js';
import type { Transport } from './transport/base.js';
import { GrpcTransport } from './transport/grpc.js';
import { createStream, createBatch } from './commands/create.js';
import { acceptStream } from './commands/accept.js';
import { withdraw } from './commands/withdraw.js';
import { cancel, mutualCancel } from './commands/cancel.js';
import { renew } from './commands/renew.js';
import { finalizeEscrow } from './commands/finalize.js';
import { getStream, listStreams, getStreamHistory } from './commands/query.js';
import { listPendingStreamRequests } from './commands/requests.js';
import { listPolicies, revokePolicy, listExecutionLogs } from './commands/policy.js';
import { ESCROW_TEMPLATES } from './templates.js';
import type { PolicyInfo, ExecutionLogInfo } from './commands/policy.js';
import { BalanceTicker } from './accrual/ticker.js';
import { getBalances } from './accrual/calculator.js';
import { createLogger } from './utils/logger.js';
import type { Logger } from 'pino';

/**
 * Main client for Canton Payment Streams.
 *
 * All key-based operations require (sender, streamId) to match the
 * Daml contract key (Party, Text).
 */
export class CantonStreamsClient {
  /** @internal — exposed for orchestration; treat as implementation detail. */
  readonly _transport: Transport;
  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly config: ClientConfig;

  constructor(config: ClientConfig) {
    this.config = config;
    this.logger = createLogger('client', config.logLevel);
    this.transport = new GrpcTransport(config);
    this._transport = this.transport;
    this.logger.info({ host: config.host, port: config.port }, 'Client initialized');
  }

  // --- Stream Creation ---

  /**
   * Create a single payment stream.
   * Returns a pending request; the recipient must accept to activate the stream.
   */
  async createStream(params: CreateStreamParams): Promise<{ requestContractId: string; streamId: string }> {
    return createStream(this.transport, params, this.config.actAs, this.logger);
  }

  /**
   * Create multiple streams in a single batch transaction.
   */
  async createBatch(params: CreateBatchParams): Promise<{ batchContractId: string; streamIds: string[] }> {
    return createBatch(this.transport, params, this.config.actAs, this.logger);
  }

  // --- Stream Acceptance ---

  /**
   * Accept a pending stream creation request. Only the recipient can accept.
   * Transitions the CreateStreamRequest into an active StreamEscrow.
   */
  async acceptStream(sender: string, streamId: string): Promise<{ escrowContractId: string }> {
    return acceptStream(this.transport, sender, streamId, this.config.actAs, this.logger);
  }

  // --- Custody Finalization (service-only) ---

  /**
   * Finalize custody for an accepted stream request.
   *
   * Only the escrow operator service should call this. After a recipient
   * accepts a custody-backed request, the service exercises the Finalize
   * choice which locks, splits, and transfers real holdings into escrow.
   */
  async finalizeEscrow(
    sender: string,
    streamId: string,
    acceptedRequestContractId?: string,
    settlementMode?: SettlementMode,
    params?: FinalizeEscrowParams,
  ): Promise<{ escrowContractId: string }> {
    return finalizeEscrow(
      this.transport,
      sender,
      streamId,
      this.config.actAs,
      this.logger,
      acceptedRequestContractId,
      settlementMode,
      params,
    );
  }

  // --- Stream Operations (require sender + streamId) ---

  /**
   * Withdraw accrued tokens from a stream. Only the recipient can withdraw.
   */
  async withdraw(
    sender: string,
    streamId: string,
    params?: TokenStandardWithdrawParams,
  ): Promise<WithdrawResult> {
    return withdraw(this.transport, sender, streamId, params, this.config.actAs, this.logger);
  }

  /**
   * Cancel a cancellable stream. Only the sender can cancel.
   * Pro-rata settlement: accrued to recipient, remainder refunded to sender.
   */
  async cancel(
    sender: string,
    streamId: string,
    params?: TokenStandardCancelParams,
  ): Promise<CancelResult> {
    return cancel(this.transport, sender, streamId, params, this.config.actAs, this.logger);
  }

  /**
   * Mutual cancellation — requires both sender and recipient as actAs parties.
   */
  async mutualCancel(
    sender: string,
    streamId: string,
    params?: TokenStandardCancelParams,
  ): Promise<CancelResult> {
    return mutualCancel(this.transport, sender, streamId, params, this.config.actAs, this.logger);
  }

  /**
   * Renew a renewable-term stream with additional deposit and extended end time.
   */
  async renew(sender: string, streamId: string, params: RenewParams): Promise<string> {
    return renew(this.transport, sender, streamId, params, this.config.actAs, this.logger);
  }

  // --- Balance Queries ---

  /**
   * Get the current accrued balance for a stream.
   *
   * Fetches authoritative on-ledger stream state and computes the full
   * balance snapshot (accrued, withdrawable, refundable, alreadyWithdrawn).
   *
   * This is a convenience method equivalent to:
   * ```ts
   * const stream = await client.getStream(sender, streamId);
   * const balances = getBalances(stream);
   * ```
   *
   * For frequent UI updates, prefer {@link getBalanceTicker} which avoids
   * a ledger round-trip on each call.
   */
  async getAccruedBalance(sender: string, streamId: string): Promise<StreamBalances> {
    const stream = await getStream(this.transport, sender, streamId, this.config.actAs, this.logger);
    return getBalances(stream);
  }

  // --- Queries ---

  /**
   * Get a specific stream by key (sender + streamId).
   * Returns authoritative on-ledger values.
   */
  async getStream(sender: string, streamId: string): Promise<Stream> {
    return getStream(this.transport, sender, streamId, this.config.actAs, this.logger);
  }

  /**
   * List all streams visible to the acting parties, with optional filtering.
   */
  async listStreams(filter?: StreamFilter): Promise<Stream[]> {
    return listStreams(this.transport, filter, this.config.actAs, this.config.readAs, this.logger);
  }

  /**
   * List pending stream requests visible to the acting parties.
   */
  async listPendingStreamRequests(filter?: PendingStreamRequestFilter): Promise<PendingStreamRequest[]> {
    return listPendingStreamRequests(
      this.transport,
      filter,
      this.config.actAs,
      this.config.readAs,
      this.logger,
    );
  }

  /**
   * Get event history for a specific stream.
   */
  async getStreamHistory(sender: string, streamId: string): Promise<StreamEvent[]> {
    return getStreamHistory(this.transport, sender, streamId, this.config.actAs, this.logger);
  }

  // --- Policy Management (Phase 3) ---

  /**
   * List delegated policies visible to the acting parties.
   */
  async listPolicies(): Promise<PolicyInfo[]> {
    return listPolicies(this.transport, this.config.actAs, this.config.readAs, this.logger);
  }

  /**
   * Revoke a delegated policy. Only the sender can revoke.
   */
  async revokePolicy(policyContractId: string): Promise<{ newContractId: string }> {
    return revokePolicy(this.transport, policyContractId, this.config.actAs, this.logger);
  }

  /**
   * List execution logs, optionally filtered by policy ID.
   */
  async listExecutionLogs(policyId?: string): Promise<ExecutionLogInfo[]> {
    return listExecutionLogs(this.transport, policyId, this.config.actAs, this.config.readAs, this.logger);
  }

  // --- Real-time ---

  /**
   * Subscribe to real-time stream state updates via the ledger UpdateService.
   *
   * Uses the gRPC UpdateService.GetUpdates stream to push events as they
   * occur on-ledger. Each callback receives a {@link StreamUpdate} containing
   * the event and (if the stream is still active) the updated stream state.
   *
   * Requires a gRPC transport — JSON API transport does not support streaming.
   *
   * @param sender   - Stream sender party (part of the contract key).
   * @param streamId - Stream ID (part of the contract key).
   * @param onUpdate - Callback invoked for each stream event.
   * @param onError  - Optional error handler.
   * @returns A cancel function to stop the subscription.
   *
   * @example
   * ```ts
   * const cancel = client.subscribeToStream(sender, streamId, (update) => {
   *   console.log(`Event: ${update.event.type}`, update.event.payload);
   *   if (update.stream) {
   *     console.log(`New balance: ${update.stream.state.totalWithdrawn}`);
   *   }
   * });
   *
   * // Later, stop listening:
   * cancel();
   * ```
   */
  subscribeToStream(
    sender: string,
    streamId: string,
    onUpdate: (update: StreamUpdate) => void,
    onError?: (err: Error) => void,
  ): () => void {
    const transport = this.transport as any;

    if (!('getUpdates' in transport) || typeof transport.getUpdates !== 'function') {
      throw new Error(
        'subscribeToStream requires a gRPC transport. JSON API transport does not support streaming.',
      );
    }

    this.logger.info({ sender, streamId }, 'Starting stream subscription');

    // Subscribe from the current ledger end, so we only get future events.
    const matchingContractIds = new Set<string>();
    let cancelled = false;
    const cancelFns: Array<() => void> = [];

    for (const { templateId } of ESCROW_TEMPLATES) {
      try {
        const cancelFn = transport.getUpdates(
          templateId,
          undefined, // begin from current ledger end
          undefined, // no end — open-ended subscription
          this.config.actAs,
          undefined,
          (update: any) => {
            if (cancelled) return;
            const transaction = update.transaction ?? update.transaction_tree;
            if (!transaction) return;

            const effectiveTime = transaction.effective_at
              ? new Date(transaction.effective_at)
              : new Date();

            const eventsById = transaction.events_by_id ?? {};
            const flatEvents = transaction.events ?? [];
            const allEvs = Object.values(eventsById).length > 0
              ? Object.values(eventsById)
              : flatEvents;

            for (const ev of allEvs as any[]) {
              if (ev.created) {
                const payload = ev.created.create_arguments;
                if (!payload) continue;
                const config = this.decodeSimpleRecord(payload);
                if (config?.streamId === streamId && config?.sender === sender) {
                  matchingContractIds.add(ev.created.contract_id);
                }
              }

              if (ev.exercised && matchingContractIds.has(ev.exercised.contract_id)) {
                const choice = ev.exercised.choice;
                const eventType = this.choiceToEventType(choice);
                if (eventType) {
                  onUpdate({
                    event: {
                      type: eventType,
                      contractId: ev.exercised.contract_id,
                      timestamp: effectiveTime,
                      source: 'ledger',
                      payload: this.decodeSimpleRecord(ev.exercised.exercise_result) ?? {},
                    },
                  });
                }
              }
            }
          },
          (err: Error) => {
            if (!cancelled && onError) {
              onError(err);
            }
          },
          () => {
            // Stream completed
          },
        );
        cancelFns.push(cancelFn);
      } catch {
        // Template not deployed; skip
      }
    }

    return () => {
      cancelled = true;
      for (const fn of cancelFns) {
        try { fn(); } catch { /* ignore */ }
      }
      this.logger.info({ sender, streamId }, 'Stream subscription cancelled');
    };
  }

  /** Map a Daml choice name to a StreamEventType. */
  private choiceToEventType(choice: string): StreamEvent['type'] | null {
    if (choice.includes('Withdraw')) return 'withdrawn';
    if (choice.includes('MutualCancel') || choice.includes('Cancel')) return 'cancelled';
    if (choice.includes('Complete')) return 'completed';
    if (choice.includes('Renew')) return 'renewed';
    return null;
  }

  /** Minimal record decoder for subscription payloads. */
  private decodeSimpleRecord(val: any): any {
    if (!val) return undefined;
    if (val.fields && Array.isArray(val.fields)) {
      const result: Record<string, unknown> = {};
      for (const field of val.fields) {
        const v = field.value;
        if (!v) continue;
        result[field.label] = v.text ?? v.party ?? v.numeric ?? v.bool ?? v.int64 ?? v.timestamp ?? v;
      }
      return result;
    }
    if (val.record?.fields) return this.decodeSimpleRecord(val.record);
    return val;
  }

  /**
   * Get a balance ticker for real-time UI display.
   *
   * DISPLAY ONLY — the ledger is the authoritative source of truth.
   * Use getStream() for settlement-critical values.
   */
  getBalanceTicker(stream: Stream, intervalMs?: number): BalanceTicker {
    return new BalanceTicker(stream, intervalMs);
  }

  // --- Lifecycle ---

  /**
   * Close the client and release resources.
   */
  async close(): Promise<void> {
    this.logger.info('Closing client');
    await this.transport.close();
  }
}
