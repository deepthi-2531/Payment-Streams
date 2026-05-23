/**
 * @module transfer-events-subscriber
 *
 * Event-driven settlement reactor for the V2-native AllocationRequest
 * pattern (STR-77 / plan §7.6).
 *
 * Replaces the poll-based `auto-withdraw.ts` worker for assets that
 * advertise V2 capabilities (or implement AllocationRequestV1). For
 * each asset in the registry, opens a subscription:
 *
 *   - **V2 path** — subscribes to `TransferEventsV2` from the
 *     `splice-api-token-transfer-events-v2` DAR. Receives `Allocation_Settle`
 *     events directly from the V2 event package.
 *
 *   - **V1 path** — subscribes to the Ledger API transaction stream
 *     filtered by our package hashes. Detects `AllocationV1.Allocation_ExecuteTransfer`
 *     exercises by template id + choice name. (V1 uses the choice name
 *     `Allocation_ExecuteTransfer` — V2's `Allocation_Settle` is a
 *     different name for the same operation. See STR-89 V1/V2 vocabulary
 *     table.)
 *
 * On each settlement event, the subscriber exercises the corresponding
 * stream-state-advancing choice on the affected escrow contract
 * (`Withdraw_Stream` / `Withdraw_Flow` / `ConfirmMilestone`). The proxy's
 * monitoring layer subscribes to `settlement:completed` / `:failed`
 * / `:retrying` events for observability.
 *
 * Supersedes STR-55 (poll → event migration of auto-withdraw).
 *
 * ## Lifecycle
 *
 *   1. `createSubscriber(config)` instantiates the subscriber but does
 *      not start any subscriptions.
 *   2. `subscriber.start()` opens one subscription per asset in the
 *      registry. Each per-asset subscription runs as an independent
 *      EventEmitter with its own reconnect loop.
 *   3. On disconnect, exponential backoff retries up to `maxBackoffMs`,
 *      then surfaces an error event. The supervisor (proxy index.ts)
 *      decides whether to crash or continue.
 *   4. `subscriber.stop()` cleanly closes all subscriptions.
 *
 * ## Bypass for V2 DARs not yet present
 *
 * Until STR-65 lands the real V2 DARs, the V2 path is a clearly-marked
 * stub that logs a warning and falls back to the V1 path (or pure no-op
 * for V2-only assets). The structure is in place; the wire calls
 * activate when `TransferEventsV2` is importable.
 */

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * V2 settlement choice name (V2-only per STR-79).
 *
 * Per `canton-network/splice@token-standard-v2-upcoming/token-standard/splice-api-token-allocation-v2`,
 * the V2 settle choice is `Allocation_Settle`. V1 was dropped from this
 * library — V1 fires `Allocation_ExecuteTransfer` but we never subscribe
 * to it.
 */
const SETTLEMENT_CHOICES = new Set<string>([
  'Allocation_Settle',
]);

/**
 * Minimal logger interface used by the subscriber. Compatible with
 * pino's Logger as well as the silent / console-based fallback in
 * `auto-withdraw.ts`. Kept as a structural type to avoid a hard pino
 * dependency in the proxy package.
 */
export interface Logger {
  info(obj: unknown, msg?: string): void;
  info(msg: string): void;
  warn(obj: unknown, msg?: string): void;
  warn(msg: string): void;
  error(obj: unknown, msg?: string): void;
  error(msg: string): void;
  debug?(obj: unknown, msg?: string): void;
  debug?(msg: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-asset entry consumed by the subscriber (a subset of AssetConfig).
 * V2-only per STR-79 — V1 assets are not supported. */
export interface SubscriberAsset {
  readonly key: string;
  readonly displayName: string;
  readonly allocationsV2: boolean;
  readonly transferEventsV2: boolean;
  readonly scanEndpointUrl: string;
}

export interface SubscriberConfig {
  /** Ledger API base URL (for V1 transaction-stream subscriptions). */
  readonly ledgerApiUrl: string;
  /** Bearer token for Ledger API auth. */
  readonly ledgerApiToken?: string | undefined;
  /** List of assets to subscribe to. */
  readonly assets: ReadonlyArray<SubscriberAsset>;
  /** Package hashes scoping the subscription filter. */
  readonly packageHashes: ReadonlyArray<string>;
  /** Parties to subscribe as. */
  readonly subscribeAs: ReadonlyArray<string>;
  /** Initial reconnect delay (ms). Default 1000. */
  readonly initialBackoffMs?: number;
  /** Maximum reconnect delay (ms). Default 30_000. */
  readonly maxBackoffMs?: number;
  /** Logger. */
  readonly logger: Logger;
  /**
   * Optional override fetch implementation (for tests / non-Node hosts).
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Path for the offset-checkpoint file. Defaults to
   * `./.canton-streams-subscriber-offsets.json`. Override via env
   * `PROXY_SUBSCRIBER_OFFSET_FILE`.
   *
   * The file holds a `{ [assetKey]: { offset, ts } }` map. Updated
   * atomically (tmp + rename) after each batch.
   *
   * [C4 fix] Previously the subscriber hardcoded `beginExclusive: { offset: '0' }`
   * on every reconnect, replaying every settlement event from genesis on
   * every restart. With this, the subscriber resumes from last checkpoint.
   */
  readonly offsetFile?: string;
}

interface OffsetCheckpoint {
  readonly offset: string;
  readonly ts: number;
}

/**
 * Atomic, fsync-style read/write of the offset checkpoint map.
 * Stored as JSON; tmp + rename for atomicity.
 */
export class OffsetStore {
  constructor(private readonly path: string) {}

  load(): Record<string, OffsetCheckpoint> {
    if (!existsSync(this.path)) return {};
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, OffsetCheckpoint>;
      return {};
    } catch {
      return {};
    }
  }

  save(map: Record<string, OffsetCheckpoint>): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', 'utf8');
    renameSync(tmp, this.path);
  }

  getAssetOffset(assetKey: string): string {
    const map = this.load();
    return map[assetKey]?.offset ?? '0';
  }

  setAssetOffset(assetKey: string, offset: string): void {
    const map = this.load();
    map[assetKey] = { offset, ts: Date.now() };
    this.save(map);
  }
}

export function defaultOffsetFilePath(): string {
  return process.env['PROXY_SUBSCRIBER_OFFSET_FILE']
    ?? resolve(process.cwd(), '.canton-streams-subscriber-offsets.json');
}

/**
 * Settlement event payload, normalized across V1 and V2 sources.
 *
 * `originalAllocationId` correlates iterations across a committed-iterated
 * allocation chain — per the CIP-0112 May 2026 update, every
 * V2 Allocation carries `originalAllocationId : Optional Text` pointing
 * at the first allocation in the chain. Without it, the subscriber would
 * treat each iteration as an unrelated settlement and double-advance the
 * stream state. STR-97.
 *
 * For non-iterated allocations and for the first iteration, this equals
 * `allocationCid`.
 */
export interface SettlementEvent {
  readonly version: 'v1' | 'v2';
  readonly assetKey: string;
  /** Contract id of the Allocation that was settled. */
  readonly allocationCid: string;
  /** Settlement reference id (the `settlementRef.id` field). */
  readonly settlementRefId: string;
  /** Update id from the ledger transaction containing the settle event. */
  readonly updateId: string;
  /** Ledger record time of the event. */
  readonly recordTime: Date;
  /**
   * Original allocation cid for the first iteration in an iterated chain.
   * Equal to `allocationCid` for non-iterated or first iteration.
   * Undefined when the source event payload does not carry it.
   */
  readonly originalAllocationId?: string | undefined;
  /**
   * Original AllocationRequest cid that initiated this allocation chain.
   * Undefined when the source event payload does not carry it.
   */
  readonly originalRequestId?: string | undefined;
}

export type SubscriberEvent =
  | 'settlement:completed'
  | 'settlement:failed'
  | 'settlement:retrying'
  | 'subscription:opened'
  | 'subscription:closed'
  | 'subscription:error'
  | 'instruction:expired';

/**
 * V2 instruction-created event payload (STR-98).
 *
 * Per the CIP-0112 update, transfer and allocation instructions
 * carry `expiresAt` — a registry-set TTL distinct from
 * `executeBefore` / `settlementDeadline`. The registry bumps this on
 * updates; only sustained inactivity leads to expiry. Subscribers
 * capture it so they can schedule a single-shot expiry handler that
 * emits `instruction:expired` when wall-clock crosses the TTL.
 */
export interface InstructionExpiredEvent {
  readonly version: 'v2';
  readonly assetKey: string;
  /** Contract id of the transfer or allocation instruction. */
  readonly instructionCid: string;
  /** "transfer" or "allocation". */
  readonly instructionKind: 'transfer' | 'allocation';
  /** The expiresAt timestamp that has now elapsed. */
  readonly expiredAt: Date;
}

/**
 * Schedule an expiry handler for a known V2 instruction (STR-98).
 *
 * Exposed on the subscriber so callers seeing an instruction-created
 * ledger event can register the corresponding TTL handler. When wall-
 * clock crosses `expiresAt`, the subscriber emits
 * `instruction:expired` for downstream gc / cleanup logic.
 *
 * If `expiresAt` is in the past, fires synchronously on next tick.
 * If the subscriber is later stopped, queued handlers are cancelled.
 */
export interface ExpirySchedule {
  readonly instructionCid: string;
  readonly assetKey: string;
  readonly instructionKind: 'transfer' | 'allocation';
  readonly expiresAt: Date;
}

/**
 * Settlement reactor — emits events for each detected `Allocation_Settle`
 * exercise + lets callers register handlers that drive stream-state
 * advancement.
 */
export interface TransferEventsSubscriber extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** True if any per-asset subscription is currently open. */
  isRunning(): boolean;
  /** Manually inject a settlement event (for tests). */
  emitSettlement(event: SettlementEvent): void;
  /**
   * Schedule a single-shot expiry handler for a V2 instruction (STR-98).
   *
   * Returns a cancellable handle; calling `cancel()` clears the timer.
   * The subscriber also auto-cancels all pending handlers on `stop()`.
   *
   * If `schedule.expiresAt` has already passed, the handler fires on
   * the next tick.
   *
   * If `expiresAt` is updated (registry bump), call this method again
   * with the same `instructionCid` and the new `expiresAt`; previous
   * timer is automatically cancelled before scheduling the new one.
   */
  scheduleInstructionExpiry(schedule: ExpirySchedule): { cancel(): void };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class TransferEventsSubscriberImpl extends EventEmitter implements TransferEventsSubscriber {
  private readonly config: Required<Omit<SubscriberConfig, 'ledgerApiToken' | 'fetchImpl' | 'offsetFile'>> & {
    readonly ledgerApiToken?: string | undefined;
    readonly fetchImpl: typeof fetch;
    readonly offsetFile: string;
  };
  private readonly perAssetCleanup = new Map<string, () => void>();
  /** STR-98 — per-instruction TTL timers. Keyed by instructionCid. */
  private readonly pendingExpiries = new Map<string, NodeJS.Timeout>();
  /** [C4] Persistent offset store; survives restart + reconnect. */
  private readonly offsetStore: OffsetStore;
  private running = false;

  constructor(config: SubscriberConfig) {
    super();
    const offsetFile = config.offsetFile ?? defaultOffsetFilePath();
    this.config = {
      ledgerApiUrl: config.ledgerApiUrl.replace(/\/+$/, ''),
      ledgerApiToken: config.ledgerApiToken,
      assets: config.assets,
      packageHashes: config.packageHashes,
      subscribeAs: config.subscribeAs,
      initialBackoffMs: config.initialBackoffMs ?? 1000,
      maxBackoffMs: config.maxBackoffMs ?? 30_000,
      logger: config.logger,
      fetchImpl: config.fetchImpl ?? fetch,
      offsetFile,
    };
    this.offsetStore = new OffsetStore(offsetFile);
    this.config.logger.info(
      { offsetFile },
      'TransferEventsSubscriber: offset-checkpoint store initialized',
    );
  }

  /** Public accessor so the proxy can expose offset state via admin route. */
  getCheckpoints(): Record<string, { offset: string; ts: number }> {
    return this.offsetStore.load();
  }

  /** Used by admin/troubleshooting; resets all checkpoints to 0. */
  resetCheckpoints(): void {
    this.offsetStore.save({});
    this.config.logger.warn('TransferEventsSubscriber: all offset checkpoints reset to 0');
  }

  async start(): Promise<void> {
    if (this.running) {
      this.config.logger.warn('TransferEventsSubscriber.start() called while already running');
      return;
    }
    this.running = true;
    for (const asset of this.config.assets) {
      this.startPerAssetSubscription(asset);
    }
    this.config.logger.info(
      { assetCount: this.config.assets.length },
      'TransferEventsSubscriber started',
    );
  }

  async stop(): Promise<void> {
    // STR-98 — pending instruction TTL timers are independent of the
    // subscription loop's `running` flag (they can be scheduled before
    // start() is ever called, e.g. in test setup). Always cancel them
    // on stop().
    for (const [cid, timer] of this.pendingExpiries) {
      clearTimeout(timer);
      this.config.logger.debug?.({ instructionCid: cid }, 'Cancelled pending instruction TTL');
    }
    this.pendingExpiries.clear();

    if (!this.running) return;
    this.running = false;
    for (const [assetKey, cleanup] of this.perAssetCleanup) {
      this.config.logger.info({ assetKey }, 'Closing subscription');
      cleanup();
    }
    this.perAssetCleanup.clear();
    this.config.logger.info('TransferEventsSubscriber stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  emitSettlement(event: SettlementEvent): void {
    this.emit('settlement:completed', event);
  }

  /**
   * Schedule a single-shot expiry handler for a V2 instruction (STR-98).
   *
   * If the same `instructionCid` is scheduled again (e.g. the registry
   * bumped its `expiresAt`), the prior timer is cancelled before the
   * new one is created — this matches the bump-on-update semantics of
   * the CIP-0112 spec expiresAt design.
   */
  scheduleInstructionExpiry(schedule: ExpirySchedule): { cancel(): void } {
    // If we already have a timer for this cid, cancel it.
    const existing = this.pendingExpiries.get(schedule.instructionCid);
    if (existing) {
      clearTimeout(existing);
      this.pendingExpiries.delete(schedule.instructionCid);
    }

    const fireExpiry = () => {
      this.pendingExpiries.delete(schedule.instructionCid);
      const event: InstructionExpiredEvent = {
        version: 'v2',
        assetKey: schedule.assetKey,
        instructionCid: schedule.instructionCid,
        instructionKind: schedule.instructionKind,
        expiredAt: schedule.expiresAt,
      };
      this.config.logger.info(
        {
          assetKey: schedule.assetKey,
          instructionCid: schedule.instructionCid,
          instructionKind: schedule.instructionKind,
        },
        'V2 instruction expired (TTL elapsed)',
      );
      this.emit('instruction:expired', event);
    };

    const delayMs = Math.max(0, schedule.expiresAt.getTime() - Date.now());
    const timer = setTimeout(fireExpiry, delayMs);
    this.pendingExpiries.set(schedule.instructionCid, timer);

    return {
      cancel: () => {
        const t = this.pendingExpiries.get(schedule.instructionCid);
        if (t) {
          clearTimeout(t);
          this.pendingExpiries.delete(schedule.instructionCid);
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Per-asset subscription
  // -------------------------------------------------------------------------

  private startPerAssetSubscription(asset: SubscriberAsset): void {
    // V2-only per STR-79. Open the V2 TransferEvents subscription if the
    // asset advertises it; otherwise the auto-withdraw poller stays as
    // backstop (an asset with `allocationsV2 = true` but `transferEventsV2 = false`
    // still settles V2 — we just can't get push events for it).
    if (asset.transferEventsV2) {
      this.startV2Subscription(asset);
    } else {
      this.config.logger.warn(
        { assetKey: asset.key },
        'Asset does not advertise transferEventsV2 — no event subscription opened. ' +
        'Poll-based auto-withdraw remains the backstop until the asset publishes ' +
        'splice-api-token-transfer-events-v2 support.',
      );
    }
  }

  /**
   * V2 TransferEvents subscription via `EventLog_HoldingsChange` events
   * from `splice-api-token-transfer-events-v2` (STR-100).
   *
   * Per the CIP-0112 update (May 2026, PR #4638), the V2 events
   * package exposes `EventLog_HoldingsChange` — a parsed semantic event
   * stream describing all holding changes (transfers, locks, burns,
   * mints, allocation settles). This is preferred over raw transaction
   * parsing because:
   *
   *   - No coupling to choice-name matching (V2 evolutions don't break us)
   *   - Server-side parsing returns typed events with `originalAllocationId`
   *     already extracted, avoiding our heuristic argument-shape probing
   *   - Single event stream covers all V2 holding kinds (not just allocations)
   *
   * V1 raw-tx fallback is retained for assets that advertise V2
   * allocations but have not yet published `transferEventsV2` (e.g.
   * USDCx pre-upgrade). Per CIP-0112 § 5, this is expected to be
   * temporary as V1 assets dual-publish V2 interfaces.
   */
  private startV2Subscription(asset: SubscriberAsset): void {
    if (!asset.transferEventsV2) {
      // Asset advertises V2 allocations but no transfer-events-v2 source.
      // Fall back to raw-tx polling for Allocation_Settle exercises.
      this.startLedgerApiSubscription(asset);
      return;
    }
    this.startEventLogSubscription(asset);
  }

  /**
   * V2 `EventLog_HoldingsChange` subscription (STR-100).
   *
   * Opens a long-poll subscription to the asset's holdings-change event
   * endpoint and emits `settlement:completed` for each event that
   * resolves to an `Allocation_Settle`. Reconnects with exponential
   * backoff on disconnect.
   *
   * Endpoint: `${ledgerApiUrl}/v2/events/holdings-change` filtered by
   * the asset's instrumentId. Real wire shape matches the
   * `splice-api-token-transfer-events-v2` schema: each event carries
   * `kind: HoldingsChangeKind` (one of Transfer / Lock / Unlock / Burn /
   * Mint / AllocationSettle) plus `allocationCid` / `originalAllocationId`
   * / `originalRequestId` correlators where applicable.
   */
  private startEventLogSubscription(asset: SubscriberAsset): void {
    let backoffMs = this.config.initialBackoffMs;
    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    this.perAssetCleanup.set(asset.key, cleanup);

    const loop = async (): Promise<void> => {
      if (cancelled || !this.running) return;
      try {
        this.emit('subscription:opened', { assetKey: asset.key, version: 'v2' });
        this.config.logger.info(
          { assetKey: asset.key },
          'Opening V2 EventLog_HoldingsChange subscription',
        );

        await this.pollHoldingsChangeEvents(asset);

        backoffMs = this.config.initialBackoffMs;
        this.emit('subscription:closed', { assetKey: asset.key, version: 'v2' });
      } catch (err) {
        this.config.logger.error(
          { err, assetKey: asset.key, backoffMs },
          'V2 EventLog subscription error; will reconnect with backoff',
        );
        this.emit('subscription:error', { assetKey: asset.key, error: err });
        backoffMs = Math.min(backoffMs * 2, this.config.maxBackoffMs);
        this.emit('settlement:retrying', { assetKey: asset.key, backoffMs });
      } finally {
        if (!cancelled && this.running) {
          timer = setTimeout(loop, backoffMs);
        }
      }
    };

    timer = setTimeout(loop, 0);
  }

  /**
   * Poll the V2 events package's holdings-change stream and emit
   * `settlement:completed` for each `AllocationSettle` event. Returns
   * when the stream cleanly ends; throws on error.
   */
  private async pollHoldingsChangeEvents(asset: SubscriberAsset): Promise<void> {
    const url = `${this.config.ledgerApiUrl}/v2/events/holdings-change`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.ledgerApiToken) {
      headers['authorization'] = `Bearer ${this.config.ledgerApiToken}`;
    }

    // [C4 fix] Resume from last persisted offset instead of replaying from genesis.
    const resumeOffset = this.offsetStore.getAssetOffset(asset.key);
    this.config.logger.info(
      { assetKey: asset.key, resumeOffset },
      'pollHoldingsChangeEvents: resuming from checkpoint',
    );
    const body = {
      // Filter to this asset only; the scan endpoint hint lets the
      // server route to the right SV's event source per the per-asset
      // routing convention (STR-56).
      assetKey: asset.key,
      scanEndpointUrl: asset.scanEndpointUrl,
      subscribeAs: this.config.subscribeAs,
      beginExclusive: { offset: resumeOffset },
    };

    const res = await this.config.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`V2 events endpoint ${url} returned ${res.status}`);
    }

    const payload = (await res.json()) as {
      events?: ReadonlyArray<HoldingsChangeEvent>;
      endOffset?: string;
    };
    if (!payload.events) return;

    for (const event of payload.events) {
      // Only AllocationSettle resolves to a stream-state advancement.
      // Transfer/Lock/Unlock/Burn/Mint are out of scope here (subscriber
      // is a settlement reactor, not a generic holdings observer).
      if (event.kind !== 'AllocationSettle') continue;

      const settlementEvent: SettlementEvent = {
        version: 'v2',
        assetKey: asset.key,
        allocationCid: event.allocationCid,
        settlementRefId: event.settlementRefId ?? '',
        updateId: event.updateId,
        recordTime: new Date(event.recordTime ?? Date.now()),
        // V2 events package extracts these server-side; no heuristic
        // argument-shape probing required.
        originalAllocationId: event.originalAllocationId ?? event.allocationCid,
        originalRequestId: event.originalRequestId,
      };

      this.config.logger.info(
        {
          assetKey: asset.key,
          allocationCid: settlementEvent.allocationCid,
          originalAllocationId: settlementEvent.originalAllocationId,
          updateId: settlementEvent.updateId,
        },
        'Detected AllocationSettle via EventLog_HoldingsChange (V2)',
      );
      this.emit('settlement:completed', settlementEvent);
    }

    // [C4 fix] Persist the highest offset we just processed so a reconnect
    // resumes here instead of replaying from 0. Save AFTER emitting events
    // — order matters: a crash between emit and save is replayed at most
    // once (idempotent withdraw handlers tolerate this), but a crash
    // between save and emit silently drops events.
    if (payload.endOffset) {
      try {
        this.offsetStore.setAssetOffset(asset.key, payload.endOffset);
      } catch (err) {
        // Persist failures should be visible but non-fatal — at worst we
        // re-process from the previous checkpoint on next reconnect.
        this.config.logger.warn(
          { assetKey: asset.key, err },
          'Failed to persist offset checkpoint',
        );
      }
    }
  }

  /**
   * Ledger-API fallback subscription. Opens a long-poll subscription to
   * the Ledger API `/v2/updates/flats` (or equivalent) filtered to our
   * package hashes + V2 `Allocation_Settle` exercises. Reconnects with
   * exponential backoff on disconnect.
   *
   * This is the temporary path until STR-100 lands the dedicated V2
   * `splice-api-token-transfer-events-v2` consumer (`EventLog_HoldingsChange`).
   */
  private startLedgerApiSubscription(asset: SubscriberAsset): void {
    let backoffMs = this.config.initialBackoffMs;
    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    this.perAssetCleanup.set(asset.key, cleanup);

    const loop = async (): Promise<void> => {
      if (cancelled || !this.running) return;
      try {
        this.emit('subscription:opened', { assetKey: asset.key, version: 'v1' });
        this.config.logger.info({ assetKey: asset.key }, 'Opening V1 ledger-api subscription');

        // Poll the updates stream and filter for Allocation_Settle.
        await this.pollLedgerApiUpdates(asset);

        // If the poll loop returns (e.g. EOF, server-side close), reset
        // backoff and try again.
        backoffMs = this.config.initialBackoffMs;
        this.emit('subscription:closed', { assetKey: asset.key, version: 'v1' });
      } catch (err) {
        this.config.logger.error(
          { err, assetKey: asset.key, backoffMs },
          'V1 subscription error; will reconnect with backoff',
        );
        this.emit('subscription:error', { assetKey: asset.key, error: err });
        backoffMs = Math.min(backoffMs * 2, this.config.maxBackoffMs);
        this.emit('settlement:retrying', { assetKey: asset.key, backoffMs });
      } finally {
        if (!cancelled && this.running) {
          timer = setTimeout(loop, backoffMs);
        }
      }
    };

    timer = setTimeout(loop, 0);
  }

  /**
   * Poll the Ledger API's flat-updates stream and filter for exercises
   * of `Allocation_Settle` against our package hashes. Each match
   * becomes a `settlement:completed` event.
   *
   * Returns when the stream cleanly ends; throws on error.
   *
   * NOTE: this is the V1 path. The V2 path is structurally identical
   * but uses TransferEventsV2's `getEvents` endpoint instead, which
   * returns parsed semantic events rather than raw exercise records.
   */
  private async pollLedgerApiUpdates(asset: SubscriberAsset): Promise<void> {
    const url = `${this.config.ledgerApiUrl}/v2/updates/flats`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.ledgerApiToken) {
      headers['authorization'] = `Bearer ${this.config.ledgerApiToken}`;
    }

    // [C4 fix] Resume from checkpoint instead of replaying from 0.
    const resumeOffset = this.offsetStore.getAssetOffset(asset.key);
    this.config.logger.info(
      { assetKey: asset.key, resumeOffset },
      'pollLedgerApiUpdates: resuming from checkpoint',
    );

    const body = {
      filter: {
        filtersByParty: Object.fromEntries(
          this.config.subscribeAs.map((p) => [
            p,
            { cumulative: [{ identifierFilter: { TemplateFilter: {} } }] },
          ]),
        ),
      },
      verbose: false,
      beginExclusive: { offset: resumeOffset },
    };

    const res = await this.config.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Ledger API ${url} returned ${res.status}`);
    }

    // Process the response chunk-by-chunk. This is a simplified shape;
    // the real Ledger API uses gRPC server-streaming. The shape below
    // is the JSON-API fallback used in dev / test.
    const payload = (await res.json()) as {
      updates?: ReadonlyArray<RawUpdate>;
      endOffset?: string;
    };
    if (!payload.updates) return;

    let maxOffset = resumeOffset;
    for (const update of payload.updates) {
      const event = this.tryParseSettlementEvent(asset, update);
      if (event) {
        this.config.logger.info(
          { assetKey: asset.key, allocationCid: event.allocationCid, updateId: event.updateId },
          'Detected Allocation_Settle event',
        );
        this.emit('settlement:completed', event);
      }
      // Track highest offset seen even for non-matching updates so we
      // can skip them on resume.
      if (update.offset && update.offset > maxOffset) {
        maxOffset = update.offset;
      }
    }

    // [C4] Persist the high-water mark.
    const newOffset = payload.endOffset ?? maxOffset;
    if (newOffset !== resumeOffset) {
      try {
        this.offsetStore.setAssetOffset(asset.key, newOffset);
      } catch (err) {
        this.config.logger.warn(
          { assetKey: asset.key, err },
          'Failed to persist V1 offset checkpoint',
        );
      }
    }
  }

  /**
   * Try to interpret a raw update record as a settlement exercise.
   * V1 and V2 use different choice names for the same operation:
   *
   *   V1: `Allocation_ExecuteTransfer` (per docs.sync.global published spec)
   *   V2: `Allocation_Settle`          (per canton-network/splice@token-standard-v2-upcoming)
   *
   * We accept either and infer the version from the asset's capability
   * flag (see SETTLEMENT_CHOICES). See STR-89 V1/V2 vocabulary table.
   *
   * Returns undefined if the update doesn't match our filter.
   */
  private tryParseSettlementEvent(
    asset: SubscriberAsset,
    update: RawUpdate,
  ): SettlementEvent | undefined {
    if (!update.exercise) return undefined;
    if (!SETTLEMENT_CHOICES.has(update.exercise.choiceName)) return undefined;

    const tid = update.exercise.templateId ?? '';
    const inScope = this.config.packageHashes.some((h) => tid.startsWith(`${h}:`));
    if (!inScope) return undefined;

    // Heuristic v1/v2 split by package hash; the real implementation
    // would consult the manifest. For the scaffold, infer V2 from
    // asset capability flag.
    const version: 'v1' | 'v2' = asset.transferEventsV2 ? 'v2' : 'v1';

    return {
      version,
      assetKey: asset.key,
      allocationCid: update.exercise.contractId,
      settlementRefId: update.exercise.argument?.settlementRefId ?? '',
      updateId: update.updateId,
      recordTime: new Date(update.recordTime ?? Date.now()),
      // STR-97 — pull through the iteration-chain correlators when present
      // on the exercise argument. Fall back to allocationCid (the first
      // iteration is its own original).
      originalAllocationId:
        update.exercise.argument?.originalAllocationId ?? update.exercise.contractId,
      originalRequestId: update.exercise.argument?.originalRequestId,
    };
  }
}

/**
 * V2 `EventLog_HoldingsChange` event shape (STR-100).
 *
 * Mirrors the `splice-api-token-transfer-events-v2` event package per
 * the CIP-0112 update. Subscribers receive a typed semantic
 * event for each holdings change instead of raw transactions, with
 * the iteration-chain correlators (`originalAllocationId`,
 * `originalRequestId`) already extracted server-side.
 */
interface HoldingsChangeEvent {
  readonly kind:
    | 'Transfer'
    | 'Lock'
    | 'Unlock'
    | 'Burn'
    | 'Mint'
    | 'AllocationSettle';
  readonly updateId: string;
  readonly recordTime?: string;
  /** Allocation contract id (AllocationSettle events only). */
  readonly allocationCid: string;
  /** Settlement reference id from the settled allocation. */
  readonly settlementRefId?: string;
  /** First allocation in the iteration chain (STR-97). */
  readonly originalAllocationId?: string;
  /** Originating AllocationRequest cid (STR-97). */
  readonly originalRequestId?: string;
}

/**
 * Raw shape of an exercise update record returned by the Ledger API.
 * Real implementations should use the Ledger API's typed Update / Event
 * protobuf shapes; we use a loose JSON shape here for cross-transport
 * compatibility (gRPC + JSON-API both produce this).
 */
interface RawUpdate {
  readonly updateId: string;
  readonly recordTime?: string;
  /** [C4] Ledger offset of this update, used for checkpoint persistence. */
  readonly offset?: string;
  readonly exercise?: {
    readonly contractId: string;
    readonly templateId?: string;
    readonly choiceName: string;
    readonly argument?: {
      readonly settlementRefId?: string;
      readonly originalAllocationId?: string;
      readonly originalRequestId?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Factory + convenience helpers
// ---------------------------------------------------------------------------

/**
 * Create a new TransferEventsSubscriber. The returned object is an
 * EventEmitter; subscribe to `settlement:completed` etc. before calling
 * `start()`.
 *
 * @example
 * ```ts
 * const subscriber = createSubscriber({
 *   ledgerApiUrl: process.env.CANTON_LEDGER_API_URL!,
 *   ledgerApiToken: process.env.CANTON_LEDGER_API_TOKEN,
 *   assets: registry.listAssets(),
 *   packageHashes: [CANTON_STREAMS_PACKAGE_HASH],
 *   subscribeAs: [escrowOperatorParty],
 *   logger,
 * });
 * subscriber.on('settlement:completed', async (event) => {
 *   // exercise Withdraw_Stream / Withdraw_Flow / ConfirmMilestone
 *   // on the corresponding stream contract to advance state
 *   await advanceStreamState(event);
 * });
 * await subscriber.start();
 * ```
 */
export function createSubscriber(config: SubscriberConfig): TransferEventsSubscriber {
  return new TransferEventsSubscriberImpl(config);
}
