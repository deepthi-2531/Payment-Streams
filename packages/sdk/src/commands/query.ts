/**
 * Stream query commands.
 *
 * All queries target StreamHoldingEscrow — the production template backed
 * by Daml Finance holdings.
 *
 * @module commands/query
 */

import type { Transport } from '../transport/base.js';
import type {
  Stream,
  StreamConfig,
  StreamState,
  StreamFilter,
  StreamEvent,
  InstrumentRef,
  VestingModeConfig,
} from '../types/stream.js';
import { VestingMode, StreamStatus, AssetType, SettlementMode } from '../types/stream.js';
import type {
  TEMPLATE_STREAM_ESCROW} from '../templates.js';
import {
  ESCROW_TEMPLATES,
  CHOICE_WITHDRAW_STREAM,
  CHOICE_WITHDRAW_UTILITY,
  CHOICE_WITHDRAW_TOKEN_STANDARD,
  CHOICE_WITHDRAW_LOCAL_ASSET,
  CHOICE_CANCEL_STREAM,
  CHOICE_CANCEL_UTILITY,
  CHOICE_CANCEL_TOKEN_STANDARD,
  CHOICE_CANCEL_LOCAL_ASSET,
  CHOICE_MUTUAL_CANCEL_STREAM,
  CHOICE_MUTUAL_CANCEL_UTILITY,
  CHOICE_MUTUAL_CANCEL_TOKEN_STANDARD,
  CHOICE_MUTUAL_CANCEL_LOCAL_ASSET,
  CHOICE_RENEW_STREAM,
  CHOICE_RENEW_UTILITY,
  CHOICE_RENEW_TOKEN_STANDARD,
  CHOICE_RENEW_LOCAL_ASSET,
  CHOICE_COMPLETE_STREAM,
} from '../templates.js';
import type { Logger } from 'pino';
import Decimal from 'decimal.js';

type EscrowTemplateDescriptor = (typeof ESCROW_TEMPLATES)[number];

interface StreamMatch {
  readonly stream: Stream;
  readonly template: EscrowTemplateDescriptor;
  readonly offset?: bigint;
}

interface HistoricalStreamSnapshot extends StreamMatch {
  readonly offset: bigint;
  readonly timestamp: Date;
}

/**
 * Get a specific stream by key (sender + streamId).
 *
 * Uses ACS query and filters by sender + streamId to find the matching
 * StreamEscrow contract. This avoids exercising a ledger choice just
 * for reads, which is simpler and works regardless of which choices
 * the deployed template exposes.
 */
export async function getStream(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  logger: Logger,
): Promise<Stream> {
  logger.debug({ sender, streamId }, 'Getting stream by key (ACS query across all templates)');

  const activeMatch = await findActiveStreamMatch(
    transport,
    sender,
    streamId,
    actAs,
  );
  if (activeMatch) {
    return activeMatch.stream;
  }

  const historicalSnapshot = await findHistoricalStreamSnapshot(
    transport,
    sender,
    streamId,
    actAs,
    logger,
  );
  if (historicalSnapshot) {
    logger.debug(
      { sender, streamId, offset: historicalSnapshot.offset.toString() },
      'Returning archived stream reconstructed from recent ledger history',
    );
    return historicalSnapshot.stream;
  }

  throw new Error(`Stream not found: sender=${sender}, streamId=${streamId}`);
}

/**
 * List all streams visible to the acting parties, with optional filtering.
 */
export async function listStreams(
  transport: Transport,
  filter: StreamFilter | undefined,
  actAs: string[],
  readAs: string[] | undefined,
  logger: Logger,
): Promise<Stream[]> {
  logger.debug({ filter }, 'Listing streams (querying all template types)');

  // Query each escrow template separately and merge results.
  // Each result is tagged with its settlement mode from explicit template metadata.
  let streams: Stream[] = [];

  for (const { templateId, settlementMode } of ESCROW_TEMPLATES) {
    // Skip templates that don't match the settlement mode filter (if set)
    if (filter?.settlementMode && filter.settlementMode !== settlementMode) {
      continue;
    }

    try {
      const results = await transport.query<any>(
        templateId,
        undefined,
        actAs,
        readAs,
      );

      const templateStreams = results.map((raw: any) =>
        deserializeActiveContract(raw, settlementMode),
      );
      streams = streams.concat(templateStreams);
    } catch {
      // Template might not be deployed yet; skip silently
      continue;
    }
  }

  // Apply remaining filters
  if (filter) {
    if (filter.sender) {
      streams = streams.filter((s) => s.config.sender === filter.sender);
    }
    if (filter.recipient) {
      streams = streams.filter((s) => s.config.recipient === filter.recipient);
    }
    if (filter.status) {
      streams = streams.filter((s) => s.state.status === filter.status);
    }
    if (filter.vestingMode) {
      streams = streams.filter((s) => s.config.vestingMode.mode === filter.vestingMode);
    }
  }

  logger.debug({ count: streams.length }, 'Streams listed');
  return streams;
}

/**
 * Get event history for a specific stream.
 *
 * Uses the UpdateService.GetUpdates gRPC stream to fetch historical
 * transaction events for the given stream. The transport must support
 * the getUpdates method for ledger-backed history.
 *
 * If the transport doesn't support getUpdates (or for backwards
 * compatibility), falls back to state-synthesis from the current contract.
 */
export async function getStreamHistory(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  logger: Logger,
): Promise<StreamEvent[]> {
  logger.debug({ sender, streamId }, 'Getting stream history');

  // Try ledger-backed history via UpdateService
  if ('getUpdates' in transport && typeof (transport as any).getUpdates === 'function') {
    try {
      const events = await getLedgerHistory(transport, sender, streamId, actAs, logger);
      if (events.length > 0) {
        logger.debug({ sender, streamId, count: events.length }, 'Returning ledger-backed history');
        return events;
      }
      logger.debug({ sender, streamId }, 'Ledger history returned no events, trying state synthesis');
    } catch (err) {
      logger.warn({ sender, streamId, err }, 'Ledger history failed, falling back to state synthesis');
    }
  }

  // Fallback: synthesize from current state. This produces approximate events
  // derived from the contract's current fields (e.g. totalWithdrawn) rather than
  // individual ledger transactions. Events are marked with source: 'state' so
  // the UI can distinguish them from authoritative ledger events.
  return getStateBasedHistory(transport, sender, streamId, actAs, logger);
}

// Recent stream actions are clustered close to the current contract offset
// because every withdraw/cancel/renew recreates the stream. Keeping this
// window tight avoids replaying a large slice of the ledger just to build
// history for a single stream.
// Lookback window for history queries. Canton recreates contracts on every
// exercise, so the current contract offset is recent. But the initial create
// may be further back, so we use a generous window.
const HISTORY_LOOKBACK_OFFSETS = 10_000n;
const HISTORY_SCAN_WINDOW_COUNT = 8;

/** Set of all withdrawal choice names across settlement modes. */
const WITHDRAW_CHOICES = new Set([CHOICE_WITHDRAW_STREAM, CHOICE_WITHDRAW_UTILITY, CHOICE_WITHDRAW_TOKEN_STANDARD, CHOICE_WITHDRAW_LOCAL_ASSET]);

/** Set of all cancellation choice names across settlement modes. */
const CANCEL_CHOICES = new Set([
  CHOICE_CANCEL_STREAM, CHOICE_CANCEL_UTILITY, CHOICE_CANCEL_LOCAL_ASSET,
  CHOICE_CANCEL_TOKEN_STANDARD,
  CHOICE_MUTUAL_CANCEL_STREAM, CHOICE_MUTUAL_CANCEL_UTILITY, CHOICE_MUTUAL_CANCEL_TOKEN_STANDARD, CHOICE_MUTUAL_CANCEL_LOCAL_ASSET,
]);

/** Set of all renewal choice names across settlement modes. */
const RENEW_CHOICES = new Set([CHOICE_RENEW_STREAM, CHOICE_RENEW_UTILITY, CHOICE_RENEW_TOKEN_STANDARD, CHOICE_RENEW_LOCAL_ASSET]);

/** Set of all complete choice names. */
const COMPLETE_CHOICES = new Set([CHOICE_COMPLETE_STREAM]);

/**
 * Fetch real ledger history via UpdateService.GetUpdates.
 *
 * Queries each escrow template type and maps all choice names (numeric,
 * utility, local asset) to unified event types.
 */
async function getLedgerHistory(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  logger: Logger,
): Promise<StreamEvent[]> {
  const allEvents: StreamEvent[] = [];
  const historyWindow = await findHistoryWindow(transport, sender, streamId, actAs);
  const templates = historyWindow.template
    ? [historyWindow.template]
    : ESCROW_TEMPLATES.map(({ templateId }) => ({ templateId }));

  // Query the matching escrow template if we can identify it from ACS;
  // otherwise fall back to scanning all known templates.
  for (const { templateId } of templates) {
    try {
      const events = await getLedgerHistoryForTemplate(
        transport,
        templateId,
        historyWindow.beginOffset,
        historyWindow.endOffset,
        sender,
        streamId,
        actAs,
        logger,
      );
      allEvents.push(...events);
    } catch {
      // Template might not be deployed; skip
      continue;
    }
  }

  // Sort by timestamp
  allEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return allEvents;
}

async function getLedgerHistoryForTemplate(
  transport: Transport,
  templateId: typeof TEMPLATE_STREAM_ESCROW,
  beginOffset: string,
  endOffset: string | undefined,
  sender: string,
  streamId: string,
  actAs: string[],
  logger: Logger,
): Promise<StreamEvent[]> {
  return new Promise((resolve) => {
    const events: StreamEvent[] = [];
    const matchingContractIds = new Set<string>();
    let sawInitialCreate = false;
    const grpcTransport = transport as any;

    if (!('getUpdates' in grpcTransport) || typeof grpcTransport.getUpdates !== 'function') {
      resolve([]);
      return;
    }

    const cancelFn = grpcTransport.getUpdates(
      templateId,
      beginOffset,
      endOffset,
      actAs,
      undefined,
      (update: any) => {
        const transaction = update.transaction ?? update.transaction_tree;
        if (!transaction) return;

        const effectiveTime = historyTimestamp(
          transaction.effective_at ?? transaction.record_time,
        );

        const eventsById = transaction.events_by_id ?? {};
        const flatEvents = transaction.events ?? [];
        const allEvs = Object.values(eventsById).length > 0
          ? Object.values(eventsById)
          : flatEvents;

        for (const ev of allEvs as any[]) {
          if (ev.created) {
            const payload = ev.created.create_arguments;
            if (!payload) continue;
            const decodedPayload = decodeHistoryValue(payload);
            const config = decodedPayload?.config;
            if (config?.streamId === streamId && config?.sender === sender) {
              matchingContractIds.add(ev.created.contract_id);

              if (!sawInitialCreate) {
                sawInitialCreate = true;
                events.push({
                  type: 'created',
                  contractId: ev.created.contract_id,
                  timestamp: historyTimestamp(ev.created.created_at) ?? effectiveTime,
                  source: 'ledger',
                  payload: {
                    sender: config.sender,
                    recipient: config.recipient,
                    totalDeposited: config.totalDeposited,
                    vestingMode: config.vestingMode?.tag ?? config.vestingMode,
                  },
                });
              }
            }
          }

          if (ev.exercised) {
            if (!matchingContractIds.has(ev.exercised.contract_id)) {
              continue;
            }

            const choice = ev.exercised.choice;
            const contractId = ev.exercised.contract_id;
            const result = decodeHistoryValue(ev.exercised.exercise_result);

            // Map all settlement-mode choice names to unified event types
            if (WITHDRAW_CHOICES.has(choice)) {
              const newStatus = result?.newStatus as StreamStatus | undefined;
              events.push({
                type: 'withdrawn',
                contractId,
                timestamp: effectiveTime,
                source: 'ledger',
                payload: {
                  amountWithdrawn: result?.amountWithdrawn,
                  newTotalWithdrawn: result?.newTotalWithdrawn,
                  newStatus,
                },
              });

              if (newStatus === StreamStatus.Completed) {
                events.push({
                  type: 'completed',
                  contractId,
                  timestamp: effectiveTime,
                  source: 'ledger',
                  payload: {},
                });
              }
            } else if (CANCEL_CHOICES.has(choice)) {
              events.push({
                type: 'cancelled',
                contractId,
                timestamp: effectiveTime,
                source: 'ledger',
                payload: {
                  recipientAmount: result?.recipientAmount,
                  senderRefund: result?.senderRefund,
                },
              });
            } else if (COMPLETE_CHOICES.has(choice)) {
              events.push({
                type: 'completed',
                contractId,
                timestamp: effectiveTime,
                source: 'ledger',
                payload: {},
              });
            } else if (RENEW_CHOICES.has(choice)) {
              events.push({
                type: 'renewed',
                contractId,
                timestamp: effectiveTime,
                source: 'ledger',
                payload: {
                  additionalDeposit: result?.additionalDeposit?.amount,
                },
              });
            }
          }
        }
      },
      (err: Error) => {
        const maybeCode = (err as any)?.grpcCode ?? (err as any)?.code;
        if (maybeCode !== 1 && maybeCode !== 'CANCELLED') {
          logger.warn({ err }, 'UpdateService stream error during history fetch');
        }
        resolve(events);
      },
      () => {
        resolve(events);
      },
    );

    // Safety timeout
    setTimeout(() => {
      cancelFn();
      resolve(events);
    }, 10_000);
  });
}

async function findHistoryWindow(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
): Promise<{
  beginOffset: string;
  endOffset?: string;
  template?: { templateId: typeof TEMPLATE_STREAM_ESCROW };
}> {
  const activeMatch = await findActiveStreamMatch(
    transport,
    sender,
    streamId,
    actAs,
  );
  if (activeMatch?.offset !== undefined) {
    const begin = activeMatch.offset > HISTORY_LOOKBACK_OFFSETS
      ? activeMatch.offset - HISTORY_LOOKBACK_OFFSETS
      : 0n;
    return {
      beginOffset: begin.toString(),
      endOffset: activeMatch.offset.toString(),
      template: { templateId: activeMatch.template.templateId },
    };
  }

  const historicalSnapshot = await findHistoricalStreamSnapshot(
    transport,
    sender,
    streamId,
    actAs,
  );
  if (historicalSnapshot) {
    const begin = historicalSnapshot.offset > HISTORY_LOOKBACK_OFFSETS
      ? historicalSnapshot.offset - HISTORY_LOOKBACK_OFFSETS
      : 0n;
    return {
      beginOffset: begin.toString(),
      endOffset: historicalSnapshot.offset.toString(),
      template: { templateId: historicalSnapshot.template.templateId },
    };
  }

  const ledgerEnd = await getCurrentLedgerEndOffset(transport);
  if (ledgerEnd !== undefined) {
    const begin = ledgerEnd > HISTORY_LOOKBACK_OFFSETS
      ? ledgerEnd - HISTORY_LOOKBACK_OFFSETS
      : 0n;
    return {
      beginOffset: begin.toString(),
      endOffset: ledgerEnd.toString(),
    };
  }

  // Last resort for transports without ledger-end access.
  return { beginOffset: '0' };
}

function historyTimestamp(raw: any): Date {
  return deserializeTime(raw ?? new Date().toISOString());
}

function decodeHistoryValue(val: any): any {
  if (!val) return undefined;
  if ('text' in val) return val.text;
  if ('int64' in val) return val.int64;
  if ('numeric' in val) return val.numeric;
  if ('bool' in val) return val.bool;
  if ('timestamp' in val) return val.timestamp;
  if ('party' in val) return val.party;
  if ('contract_id' in val) return val.contract_id;
  if ('unit' in val) return undefined;
  if ('enum' in val) return val.enum.enum_constructor;
  if ('record' in val) {
    const result: Record<string, unknown> = {};
    for (const field of val.record.fields ?? []) {
      result[field.label] = decodeHistoryValue(field.value);
    }
    return result;
  }
  // Top-level record (e.g. create_arguments) has `fields` directly, not wrapped in `record`
  if ('fields' in val && Array.isArray(val.fields)) {
    const result: Record<string, unknown> = {};
    for (const field of val.fields) {
      result[field.label] = decodeHistoryValue(field.value);
    }
    return result;
  }
  if ('variant' in val) {
    return {
      tag: val.variant.variant_constructor,
      value: decodeHistoryValue(val.variant.value),
    };
  }
  if ('list' in val) {
    return (val.list.elements ?? []).map((e: any) => decodeHistoryValue(e));
  }
  if ('optional' in val) {
    return val.optional?.value != null ? decodeHistoryValue(val.optional.value) : undefined;
  }
  return val;
}

/**
 * Fallback: synthesize a minimal history from current contract state.
 *
 * This is an approximation — timestamps for withdrawal/cancellation events
 * come from the contract's lastWithdrawTime field rather than the actual
 * ledger effective time. For accurate history, the UpdateService path above
 * should be used.
 */
async function getStateBasedHistory(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  logger: Logger,
): Promise<StreamEvent[]> {
  try {
    const stream = await getStream(transport, sender, streamId, actAs, logger);
    const events: StreamEvent[] = [];

    // Created event
    events.push({
      type: 'created',
      contractId: stream.contractId,
      timestamp: stream.config.startTime,
      source: 'state',
      payload: {
        sender: stream.config.sender,
        recipient: stream.config.recipient,
        totalDeposited: stream.config.totalDeposited.toString(),
        vestingMode: stream.config.vestingMode.mode,
      },
    });

    // Withdrawal events (aggregated — we only know the total from contract state)
    if (stream.state.totalWithdrawn.greaterThan(0)) {
      events.push({
        type: 'withdrawn',
        contractId: stream.contractId,
        timestamp: stream.state.lastWithdrawTime ?? stream.config.startTime,
        source: 'state',
        payload: {
          amountWithdrawn: stream.state.totalWithdrawn.toString(),
          newTotalWithdrawn: stream.state.totalWithdrawn.toString(),
        },
      });
    }

    // Terminal status events
    if (stream.state.status === StreamStatus.Completed) {
      events.push({
        type: 'completed',
        contractId: stream.contractId,
        timestamp: stream.state.lastWithdrawTime ?? stream.config.endTime,
        source: 'state',
        payload: {},
      });
    } else if (stream.state.status === StreamStatus.Cancelled) {
      events.push({
        type: 'cancelled',
        contractId: stream.contractId,
        timestamp: stream.state.lastWithdrawTime ?? stream.config.startTime,
        source: 'state',
        payload: {},
      });
    }

    // Renewal events (aggregated — we only know the count from contract state)
    if (stream.state.renewalCount > 0) {
      events.push({
        type: 'renewed',
        contractId: stream.contractId,
        timestamp: stream.state.lastWithdrawTime ?? stream.config.startTime,
        source: 'state',
        payload: {
          renewalCount: stream.state.renewalCount,
        },
      });
    }

    return events;
  } catch (err) {
    logger.warn({ sender, streamId, err }, 'Failed to get stream for history');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

/**
 * Deserialize a GetStreamInfo (StreamView) response.
 *
 * Daml StreamView has: { config : StreamConfig, state : StreamState }
 */
export function deserializeStreamView(raw: any): Stream {
  return {
    contractId: raw.contractId ?? raw.contract_id ?? '',
    config: deserializeConfig(raw.config ?? raw),
    state: deserializeState(raw.state ?? raw),
  };
}

/**
 * Deserialize an active contract query result.
 *
 * ACS query returns the full template payload. The settlement mode is
 * determined by explicit template metadata (which template the contract
 * came from), NOT by field-shape detection.
 *
 * For custody-backed streams, escrowRef is populated from the contract payload.
 */
function deserializeActiveContract(raw: any, settlementMode: SettlementMode = SettlementMode.NumericLegacy): Stream {
  const stream: Stream = {
    contractId: raw.contractId ?? raw.contract_id ?? '',
    config: {
      ...deserializeConfig(raw.config),
      settlementMode,
    },
    state: deserializeState(raw.state),
  };

  // For custody-backed templates, extract escrowRef from the contract payload
  if (settlementMode === SettlementMode.TokenStandardCustody) {
    return {
      ...stream,
      escrowRef: {
        escrowHoldingCid: raw.escrowReference ?? '',
        escrowAmount: raw.escrowAmount?.toString() ?? '0',
        escrowOperator: raw.escrowOperator ?? '',
        instrumentRef: deserializeInstrumentRef(raw.config?.instrumentRef ?? raw.instrumentRef) ?? {
          depository: '',
          issuer: '',
          instrumentId: '',
          instrumentVersion: '',
        },
        recipientAccount: (deserializeLedgerRecordFromText(raw.recipientAccountRef) ?? {}) as Record<string, never>,
        fundingReference: raw.fundingReference,
        lastSettlementReference: raw.lastSettlementReference?.tag === 'Some'
          ? raw.lastSettlementReference.value
          : raw.lastSettlementReference?.text ?? raw.lastSettlementReference,
        senderAccountRef: raw.senderAccountRef,
        recipientAccountRef: raw.recipientAccountRef,
      },
    };
  }

  if (settlementMode !== SettlementMode.NumericLegacy && raw.escrowHolding) {
    return {
      ...stream,
      escrowRef: {
        escrowHoldingCid: raw.escrowHolding?.holdingCid ?? '',
        escrowAmount: raw.escrowHolding?.amount?.toString() ?? '0',
        escrowOperator: raw.escrowOperator ?? '',
        instrumentRef: deserializeInstrumentRef(raw.instrumentRef ?? raw.escrowHolding?.instrumentRef) ?? {
          depository: '',
          issuer: '',
          instrumentId: '',
          instrumentVersion: '',
        },
        recipientAccount:
          raw.recipientAccount && typeof raw.recipientAccount === 'object' && !Array.isArray(raw.recipientAccount)
            ? raw.recipientAccount
            : {},
        operator: raw.escrowHolding?.operator,
        provider: raw.escrowHolding?.provider,
        registrar: raw.escrowHolding?.registrar,
        owner: raw.escrowHolding?.owner,
        label: raw.escrowHolding?.label,
      },
    };
  }

  return stream;
}

function deserializeConfig(raw: any): StreamConfig {
  return {
    streamId: raw.streamId,
    sender: raw.sender,
    recipient: raw.recipient,
    totalDeposited: new Decimal(raw.totalDeposited),
    startTime: deserializeTime(raw.startTime),
    endTime: deserializeTime(raw.endTime),
    vestingMode: deserializeVestingMode(raw.vestingMode),
    assetType: deserializeAssetType(raw.assetType),
    instrumentRef: deserializeInstrumentRef(raw.instrumentRef),
    cancellable: raw.cancellable ?? true,
  };
}

function deserializeState(raw: any): StreamState {
  return {
    totalWithdrawn: new Decimal(raw.totalWithdrawn ?? '0'),
    status: (raw.status as StreamStatus) ?? StreamStatus.Active,
    lastWithdrawTime: raw.lastWithdrawTime ? deserializeTime(raw.lastWithdrawTime) : undefined,
    renewalCount: Number(raw.renewalCount ?? 0),
  };
}

/**
 * Deserialize a Daml Time from Ledger API format.
 *
 * The Ledger API may return timestamps as:
 *   - ISO 8601 string (from JSON-API or proto-loader defaults)
 *   - Microseconds-since-epoch string (from int64 encoding)
 *   - Proto Timestamp object { seconds, nanos }
 *
 * We handle all three cases.
 */
function deserializeTime(raw: any): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') {
    // Try as microseconds-since-epoch (all digits)
    if (/^\d+$/.test(raw)) {
      return new Date(Number(BigInt(raw) / 1000n));
    }
    // Otherwise treat as ISO string
    return new Date(raw);
  }
  if (typeof raw === 'object' && raw !== null && 'seconds' in raw) {
    // Proto Timestamp: { seconds: string|number, nanos: number }
    const seconds = typeof raw.seconds === 'string' ? BigInt(raw.seconds) : BigInt(raw.seconds);
    const nanos = raw.nanos ?? 0;
    return new Date(Number(seconds * 1000n) + Math.floor(nanos / 1_000_000));
  }
  if (typeof raw === 'number') {
    // Assume milliseconds
    return new Date(raw);
  }
  return new Date(raw);
}

async function findActiveStreamMatch(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
): Promise<StreamMatch | undefined> {
  for (const template of ESCROW_TEMPLATES) {
    try {
      const results = await transport.query<any>(
        template.templateId,
        undefined,
        actAs,
        undefined,
      );

      const match = results.find(
        (raw: any) =>
          raw?.config?.sender === sender && raw?.config?.streamId === streamId,
      );

      if (match) {
        return {
          stream: deserializeActiveContract(match, template.settlementMode),
          template,
          offset: parseLedgerOffset(match?._offset),
        };
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

async function findHistoricalStreamSnapshot(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  logger?: Logger,
): Promise<HistoricalStreamSnapshot | undefined> {
  const ledgerEnd = await getCurrentLedgerEndOffset(transport);
  if (ledgerEnd === undefined) {
    return undefined;
  }

  let windowEnd = ledgerEnd;
  for (let attempt = 0; attempt < HISTORY_SCAN_WINDOW_COUNT; attempt += 1) {
    const windowBegin = windowEnd > HISTORY_LOOKBACK_OFFSETS
      ? windowEnd - HISTORY_LOOKBACK_OFFSETS
      : 0n;

    const snapshot = await findHistoricalStreamSnapshotInWindow(
      transport,
      sender,
      streamId,
      actAs,
      windowBegin.toString(),
      windowEnd.toString(),
    );
    if (snapshot) {
      logger?.debug?.(
        {
          sender,
          streamId,
          attempt: attempt + 1,
          beginOffset: windowBegin.toString(),
          endOffset: windowEnd.toString(),
          matchedOffset: snapshot.offset.toString(),
        },
        'Found archived stream snapshot in recent ledger history',
      );
      return snapshot;
    }

    if (windowBegin === 0n) {
      break;
    }
    windowEnd = windowBegin;
  }

  return undefined;
}

async function findHistoricalStreamSnapshotInWindow(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  beginOffset: string,
  endOffset: string,
): Promise<HistoricalStreamSnapshot | undefined> {
  let latestSnapshot: HistoricalStreamSnapshot | undefined;

  for (const template of ESCROW_TEMPLATES) {
    const snapshot = await findHistoricalStreamSnapshotForTemplate(
      transport,
      template,
      beginOffset,
      endOffset,
      sender,
      streamId,
      actAs,
    );
    if (snapshot && isNewerHistoricalSnapshot(snapshot, latestSnapshot)) {
      latestSnapshot = snapshot;
    }
  }

  return latestSnapshot;
}

async function findHistoricalStreamSnapshotForTemplate(
  transport: Transport,
  template: EscrowTemplateDescriptor,
  beginOffset: string,
  endOffset: string,
  sender: string,
  streamId: string,
  actAs: string[],
): Promise<HistoricalStreamSnapshot | undefined> {
  const grpcTransport = transport as any;
  if (!('getUpdates' in grpcTransport) || typeof grpcTransport.getUpdates !== 'function') {
    return undefined;
  }

  return new Promise((resolve) => {
    let latestSnapshot: HistoricalStreamSnapshot | undefined;
    let settled = false;
    // eslint-disable-next-line prefer-const -- assigned later inside the same closure but referenced earlier in `finish`
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelFn: (() => void) | undefined;

    const finish = (result?: HistoricalStreamSnapshot) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    try {
      cancelFn = grpcTransport.getUpdates(
        template.templateId,
        beginOffset,
        endOffset,
        actAs,
        undefined,
        (update: any) => {
          const transaction = update.transaction ?? update.transaction_tree;
          if (!transaction) return;

          const effectiveTime =
            historyTimestamp(transaction.effective_at ?? transaction.record_time) ??
            new Date();
          const offset =
            parseLedgerOffset(transaction.offset) ??
            parseLedgerOffset(update.offset) ??
            0n;
          const eventsById = transaction.events_by_id ?? {};
          const flatEvents = transaction.events ?? [];
          const allEvs =
            Object.values(eventsById).length > 0
              ? Object.values(eventsById)
              : flatEvents;

          for (const ev of allEvs as any[]) {
            if (!ev.created) continue;

            const payload = ev.created.create_arguments;
            if (!payload) continue;

            const decodedPayload = decodeHistoryValue(payload);
            const config = decodedPayload?.config;
            if (config?.streamId !== streamId || config?.sender !== sender) {
              continue;
            }

            const candidate: HistoricalStreamSnapshot = {
              stream: deserializeActiveContract(
                {
                  ...(decodedPayload ?? {}),
                  contractId: ev.created.contract_id,
                },
                template.settlementMode,
              ),
              template,
              offset,
              timestamp: historyTimestamp(ev.created.created_at) ?? effectiveTime,
            };

            if (isNewerHistoricalSnapshot(candidate, latestSnapshot)) {
              latestSnapshot = candidate;
            }
          }
        },
        () => finish(latestSnapshot),
        () => finish(latestSnapshot),
      );
    } catch {
      finish(undefined);
      return;
    }

    timeout = setTimeout(() => {
      try {
        cancelFn?.();
      } catch {
        // Ignore cancellation errors on timeout.
      }
      finish(latestSnapshot);
    }, 5_000);
  });
}

function parseLedgerOffset(raw: unknown): bigint | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  return BigInt(text);
}

async function getCurrentLedgerEndOffset(
  transport: Transport,
): Promise<bigint | undefined> {
  const grpcTransport = transport as any;
  if (
    !('getLedgerEnd' in grpcTransport) ||
    typeof grpcTransport.getLedgerEnd !== 'function'
  ) {
    return undefined;
  }

  try {
    const offset = await grpcTransport.getLedgerEnd();
    return parseLedgerOffset(offset);
  } catch {
    return undefined;
  }
}

function isNewerHistoricalSnapshot(
  candidate: HistoricalStreamSnapshot,
  current: HistoricalStreamSnapshot | undefined,
): boolean {
  if (!current) {
    return true;
  }
  if (candidate.offset !== current.offset) {
    return candidate.offset > current.offset;
  }
  return candidate.timestamp.getTime() > current.timestamp.getTime();
}

/**
 * Deserialize a VestingMode variant from Daml wire format.
 *
 * Daml Types.daml defines:
 *   Linear
 *   CliffLinear with cliffTime : Time
 *   Stepped with stepInterval : RelTime; amountPerStep : Decimal
 *   RenewableTerm with termDuration : RelTime
 */
function deserializeVestingMode(raw: any): VestingModeConfig {
  if (!raw) return { mode: VestingMode.Linear };

  const tag = raw.tag ?? raw.variant_constructor ?? raw;
  const value = raw.value ?? {};

  switch (tag) {
    case 'Linear':
      return { mode: VestingMode.Linear };
    case 'CliffLinear':
      return {
        mode: VestingMode.CliffLinear,
        cliffTime: deserializeTime(value.cliffTime),
      };
    case 'Stepped':
      return {
        mode: VestingMode.Stepped,
        stepInterval: deserializeRelTime(value.stepInterval),
        amountPerStep: new Decimal(value.amountPerStep?.numeric ?? value.amountPerStep ?? '0'),
      };
    case 'RenewableTerm':
      return {
        mode: VestingMode.RenewableTerm,
        termDuration: deserializeRelTime(value.termDuration),
      };
    default:
      return { mode: VestingMode.Linear };
  }
}

function deserializeRelTime(raw: any): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw);
  if (typeof raw === 'object' && raw !== null) {
    if ('microseconds' in raw) {
      return Number(raw.microseconds);
    }
    if ('int64' in raw) {
      return Number(raw.int64);
    }
  }
  return Number(raw ?? 0);
}

/**
 * Deserialize an AssetType variant from Daml wire format.
 *
 * Daml Types.daml defines:
 *   LocalToken | LocalHolding | GlobalHolding
 */
function deserializeAssetType(raw: any): AssetType {
  if (!raw) return AssetType.GlobalCip56;

  const tag = raw.tag ?? raw.variant_constructor ?? raw;
  switch (tag) {
    case 'ValidatorLocalAsset':
    case 'LocalToken':
      return AssetType.ValidatorLocalAsset;
    case 'LocalCip56':
    case 'LocalHolding':
      return AssetType.LocalCip56;
    case 'GlobalCip56':
    case 'GlobalHolding':
      return AssetType.GlobalCip56;
    default:
      return AssetType.GlobalCip56;
  }
}

/**
 * Deserialize an Optional InstrumentRef from Daml wire format.
 *
 * The gRPC transport may return optionals in several formats:
 *   1. Variant-wrapped: { tag: 'Some', value: { depository, ... } }
 *   2. Variant-wrapped: { tag: 'None', value: {} }
 *   3. Plain record (already unwrapped by transport): { depository, issuer, ... }
 *   4. null / undefined
 *
 * Returns undefined if None, null, or absent.
 */
function deserializeInstrumentRef(raw: any): InstrumentRef | undefined {
  if (!raw) return undefined;

  // Case 1/2: Variant-wrapped optional (Some/None)
  const tag = raw.tag ?? raw.variant_constructor;
  if (tag === 'None') return undefined;

  // Extract the inner value — if variant-wrapped use raw.value, otherwise raw is already the record
  const value = tag === 'Some' ? (raw.value ?? raw) : raw;
  if (!value || !value.depository) return undefined;

  return {
    depository: value.depository,
    issuer: value.issuer,
    instrumentId: value.instrumentId,
    instrumentVersion: value.instrumentVersion,
  };
}

function deserializeLedgerRecordFromText(raw: any): Record<string, unknown> | undefined {
  const text = raw?.text ?? raw;
  if (typeof text !== 'string' || !text.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore invalid JSON and fall through.
  }

  return undefined;
}
