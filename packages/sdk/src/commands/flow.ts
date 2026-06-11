/**
 * @module commands/flow
 *
 * SDK surface for the `StreamFlow` template — non-prefunded / rolling
 * top-up streaming.
 *
 * Where `StreamEscrow` is a prefunded stream with a fixed total deposit,
 * `StreamFlow` is an open-ended stream with a `flowRate` (tokens per
 * microsecond) and no end time. The sender maintains a funded balance
 * via `TopUp_Flow`; the recipient's `Withdraw_Flow` is strictly bounded
 * by the funded balance (no unsecured credit). Settlement is V2
 * iterated allocation; `numIterations` counts the settle cycles.
 *
 * ## Typical orchestration
 *
 * 1. dApp calls `buildFlowCreate(...)`; sender + recipient +
 *    escrowOperator sign and submit (all three are signatories).
 * 2. Sender keeps the balance funded via `topUpFlow` (controller:
 *    sender + escrowOperator) — each top-up corresponds to the V2
 *    `Allocation_Settle.nextIterationFunding` being adjusted upward.
 * 3. Recipient claims accrued amounts via `withdrawFlow` (controller:
 *    recipient + escrowOperator); each withdrawal advances
 *    `numIterations`.
 * 4. Sender may `pauseFlow` / `resumeFlow` (accrual clock freezes while
 *    paused).
 * 5. Mutual termination via `stopFlow` — the supplied settlement split
 *    must match the contract's own accrual computation at `stopTime`.
 */

import Decimal from 'decimal.js';
import type { Logger } from 'pino';

import type { Transport, TemplateId } from '../transport/base.js';
import {
  TEMPLATE_STREAM_FLOW,
  CHOICE_TOP_UP_FLOW,
  CHOICE_WITHDRAW_FLOW,
  CHOICE_PAUSE_FLOW,
  CHOICE_RESUME_FLOW,
  CHOICE_STOP_FLOW,
} from '../templates.js';
import type { InstrumentRefSdk } from './stream-admin.js';

// ---------------------------------------------------------------------------
// Daml wire helpers (mirrors `commands/stream-admin`)
// ---------------------------------------------------------------------------

function damlNumeric(amount: Decimal | string | number): { numeric: string } {
  return { numeric: new Decimal(amount).toFixed(10) };
}

function damlTimestamp(date: Date): { timestamp: string } {
  return { timestamp: (BigInt(date.getTime()) * 1000n).toString() };
}

function optionalText(value: string | undefined): { optional: { text: string } | null } {
  return value !== undefined ? { optional: { text: value } } : { optional: null };
}

function damlEnum(enumConstructor: string): Record<string, unknown> {
  return { enum: { enum_constructor: enumConstructor } };
}

// ---------------------------------------------------------------------------
// Input guards (mirrors `settlement/orchestrator`)
// ---------------------------------------------------------------------------

// Party ids are `<hint>::<fingerprint>`; the fingerprint is hex and never
// contains commas or newlines.
const PARTY_ID_PATTERN = /^[^,\r\n]+::[0-9a-fA-F]{8,}$/;

/** Parse an amount, rejecting empty/NaN/Infinity/<= 0. */
function requirePositiveAmount(value: Decimal | string | number, label: string): Decimal {
  let amount: Decimal;
  try {
    amount = new Decimal(value);
  } catch {
    throw new Error(`Invalid ${label}: not a number`);
  }
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw new Error(`Invalid ${label}: must be a finite amount greater than zero`);
  }
  return amount;
}

/** As requirePositiveAmount, but zero is allowed (Stop_Flow legs, initial funding). */
function requireNonNegativeAmount(value: Decimal | string | number, label: string): Decimal {
  let amount: Decimal;
  try {
    amount = new Decimal(value);
  } catch {
    throw new Error(`Invalid ${label}: not a number`);
  }
  if (!amount.isFinite() || amount.lessThan(0)) {
    throw new Error(`Invalid ${label}: must be a finite amount of at least zero`);
  }
  return amount;
}

/** Reject a party id that is empty or not in `<hint>::<fingerprint>` form. */
function requirePartyId(value: string, label: string): string {
  const party = String(value ?? '').trim();
  if (!party || !PARTY_ID_PATTERN.test(party)) {
    throw new Error(`Invalid ${label}: not a well-formed party id`);
  }
  return party;
}

/** Settlement references must be non-empty single-line text. */
function requireReference(value: string, label: string): string {
  const ref = String(value ?? '').trim();
  if (!ref || /[\r\n]/.test(ref)) {
    throw new Error(`Invalid ${label}: expected a non-empty single-line reference`);
  }
  return ref;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle states of a StreamFlow (mirrors Daml `FlowStatus`). */
export type FlowStatus = 'FlowActive' | 'FlowPaused' | 'FlowStopped';

/** Parameters for `buildFlowCreate` / `createFlow`. */
export interface CreateFlowParams {
  /** Caller-supplied unique id; generated when omitted (createFlow only). */
  readonly streamId?: string;
  readonly sender: string;
  readonly recipient: string;
  readonly escrowOperator: string;
  readonly instrumentRef: InstrumentRefSdk;
  /** Tokens per microsecond. Must be > 0. */
  readonly flowRate: Decimal | string | number;
  /** Initial funded balance. Must be >= 0. */
  readonly fundedAmount: Decimal | string | number;
  /** When accrual begins. Defaults to now. */
  readonly startTime?: Date;
  readonly observers?: ReadonlyArray<string>;
}

/** Result of `buildFlowCreate` — the create call payload. */
export interface FlowCreatePayload {
  readonly templateId: TemplateId;
  readonly argument: Record<string, unknown>;
  readonly signatories: ReadonlyArray<string>;
}

/** Result of the exercise builders — choice + argument, cid supplied at dispatch. */
export interface FlowExercisePayload {
  readonly templateId: TemplateId;
  readonly choiceName: string;
  readonly argument: Record<string, unknown>;
}

/** Parameters for `TopUp_Flow`. Controller: sender + escrowOperator. */
export interface TopUpFlowParams {
  readonly topUpAmount: Decimal | string | number;
  readonly settlementReference: string;
}

/** Parameters for `Withdraw_Flow`. Controller: recipient + escrowOperator. */
export interface WithdrawFlowParams {
  readonly settlementReference: string;
  /** Accrual is computed at this time; must be <= ledger time. Defaults to now. */
  readonly withdrawTime?: Date;
}

/** Parameters for `Pause_Flow`. Controller: sender. */
export interface PauseFlowParams {
  /** Must be <= ledger time. Defaults to now. */
  readonly pauseTime?: Date;
}

/** Parameters for `Resume_Flow`. Controller: sender. */
export interface ResumeFlowParams {
  /** Must be >= pause time and <= ledger time. Defaults to now. */
  readonly resumeTime?: Date;
}

/**
 * Parameters for `Stop_Flow`. Controller: sender + recipient +
 * escrowOperator. The contract asserts `recipientSettlement` equals the
 * owed-but-unwithdrawn amount at `stopTime` and `senderRefund` equals
 * the remaining funded balance — compute both from contract state.
 */
export interface StopFlowParams {
  readonly recipientSettlement: Decimal | string | number;
  readonly senderRefund: Decimal | string | number;
  readonly recipientSettlementReference?: string;
  readonly senderRefundReference?: string;
  /** Must be <= ledger time. Defaults to now. */
  readonly stopTime?: Date;
}

/** Decoded active StreamFlow contract. */
export interface FlowInfo {
  readonly contractId: string;
  readonly streamId: string;
  readonly sender: string;
  readonly recipient: string;
  readonly escrowOperator: string;
  readonly instrumentRef: InstrumentRefSdk;
  readonly flowRate: Decimal;
  readonly startTime: Date;
  readonly fundedAmount: Decimal;
  readonly totalWithdrawn: Decimal;
  readonly status: FlowStatus;
  readonly pausedAt?: Date | undefined;
  readonly cumulativePausedMicros: number;
  readonly lastSettlementReference?: string | undefined;
  readonly numIterations: number;
  readonly observers: ReadonlyArray<string>;
}

/** Optional filters for `listFlows`. */
export interface FlowFilter {
  readonly sender?: string;
  readonly recipient?: string;
  readonly status?: FlowStatus;
}

// ---------------------------------------------------------------------------
// Builders — pure payload construction (template id + choice + argument)
// ---------------------------------------------------------------------------

/**
 * Build the create payload for a new `StreamFlow` contract. All three
 * signatories (sender, recipient, escrowOperator) must authorize the
 * create; caller dispatches via the transport with them in actAs.
 */
export function buildFlowCreate(params: CreateFlowParams): FlowCreatePayload {
  const sender = requirePartyId(params.sender, 'sender');
  const recipient = requirePartyId(params.recipient, 'recipient');
  const escrowOperator = requirePartyId(params.escrowOperator, 'escrowOperator');
  const flowRate = requirePositiveAmount(params.flowRate, 'flowRate');
  const fundedAmount = requireNonNegativeAmount(params.fundedAmount, 'fundedAmount');
  const streamId = requireReference(params.streamId ?? '', 'streamId');

  return {
    templateId: TEMPLATE_STREAM_FLOW,
    argument: {
      sender: { party: sender },
      recipient: { party: recipient },
      escrowOperator: { party: escrowOperator },
      streamId: { text: streamId },
      instrumentRef: {
        depository: { party: params.instrumentRef.depository },
        issuer: { party: params.instrumentRef.issuer },
        instrumentId: { text: params.instrumentRef.instrumentId },
        instrumentVersion: { text: params.instrumentRef.instrumentVersion },
      },
      flowRate: damlNumeric(flowRate),
      startTime: damlTimestamp(params.startTime ?? new Date()),
      fundedAmount: damlNumeric(fundedAmount),
      totalWithdrawn: damlNumeric(0),
      status: damlEnum('FlowActive'),
      pausedAt: { optional: null },
      cumulativePausedDuration: { microseconds: { int64: '0' } },
      lastSettlementReference: { optional: null },
      numIterations: { int64: '0' },
      observers: (params.observers ?? []).map((p) => ({ party: p })),
    },
    signatories: [sender, recipient, escrowOperator],
  };
}

/** Build the `TopUp_Flow` exercise payload. */
export function buildTopUpFlow(params: TopUpFlowParams): FlowExercisePayload {
  const topUpAmount = requirePositiveAmount(params.topUpAmount, 'topUpAmount');
  const settlementReference = requireReference(params.settlementReference, 'settlementReference');
  return {
    templateId: TEMPLATE_STREAM_FLOW,
    choiceName: CHOICE_TOP_UP_FLOW,
    argument: {
      topUpAmount: damlNumeric(topUpAmount),
      settlementReference: { text: settlementReference },
    },
  };
}

/** Build the `Withdraw_Flow` exercise payload. */
export function buildWithdrawFlow(params: WithdrawFlowParams): FlowExercisePayload {
  const settlementReference = requireReference(params.settlementReference, 'settlementReference');
  return {
    templateId: TEMPLATE_STREAM_FLOW,
    choiceName: CHOICE_WITHDRAW_FLOW,
    argument: {
      withdrawTime: damlTimestamp(params.withdrawTime ?? new Date()),
      settlementReference: { text: settlementReference },
    },
  };
}

/** Build the `Pause_Flow` exercise payload. */
export function buildPauseFlow(params: PauseFlowParams = {}): FlowExercisePayload {
  return {
    templateId: TEMPLATE_STREAM_FLOW,
    choiceName: CHOICE_PAUSE_FLOW,
    argument: {
      pauseTime: damlTimestamp(params.pauseTime ?? new Date()),
    },
  };
}

/** Build the `Resume_Flow` exercise payload. */
export function buildResumeFlow(params: ResumeFlowParams = {}): FlowExercisePayload {
  return {
    templateId: TEMPLATE_STREAM_FLOW,
    choiceName: CHOICE_RESUME_FLOW,
    argument: {
      resumeTime: damlTimestamp(params.resumeTime ?? new Date()),
    },
  };
}

/** Build the `Stop_Flow` exercise payload. */
export function buildStopFlow(params: StopFlowParams): FlowExercisePayload {
  const recipientSettlement = requireNonNegativeAmount(
    params.recipientSettlement,
    'recipientSettlement',
  );
  const senderRefund = requireNonNegativeAmount(params.senderRefund, 'senderRefund');
  return {
    templateId: TEMPLATE_STREAM_FLOW,
    choiceName: CHOICE_STOP_FLOW,
    argument: {
      stopTime: damlTimestamp(params.stopTime ?? new Date()),
      recipientSettlement: damlNumeric(recipientSettlement),
      senderRefund: damlNumeric(senderRefund),
      recipientSettlementReference: optionalText(params.recipientSettlementReference),
      senderRefundReference: optionalText(params.senderRefundReference),
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatch — create / exercise / query against the transport
// ---------------------------------------------------------------------------

/**
 * Create a new `StreamFlow` contract. Generates a streamId when none is
 * supplied. `actAs` must include the sender (the ledger additionally
 * requires recipient + escrowOperator authority since all three sign).
 */
export async function createFlow(
  transport: Transport,
  params: CreateFlowParams,
  actAs: string[],
  logger: Logger,
): Promise<{ contractId: string; streamId: string }> {
  const streamId = params.streamId || crypto.randomUUID();
  if (!actAs.includes(params.sender)) {
    throw new Error(`actAs must include sender party "${params.sender}"`);
  }

  const payload = buildFlowCreate({ ...params, streamId });
  logger.info(
    { streamId, sender: params.sender, recipient: params.recipient },
    'Creating StreamFlow',
  );
  const result = await transport.create(payload.templateId, payload.argument, actAs);
  logger.info({ streamId, contractId: result.contractId }, 'StreamFlow created');
  return { contractId: result.contractId, streamId };
}

/** Sender adds to the funded balance. */
export async function topUpFlow(
  transport: Transport,
  sender: string,
  streamId: string,
  params: TopUpFlowParams,
  actAs: string[],
  logger: Logger,
): Promise<{ newFlowCid: string }> {
  return exerciseFlowChoice(transport, sender, streamId, buildTopUpFlow(params), actAs, logger);
}

/** Recipient withdraws the accrued + funded amount. */
export async function withdrawFlow(
  transport: Transport,
  sender: string,
  streamId: string,
  params: WithdrawFlowParams,
  actAs: string[],
  logger: Logger,
): Promise<{ newFlowCid: string }> {
  return exerciseFlowChoice(transport, sender, streamId, buildWithdrawFlow(params), actAs, logger);
}

/** Sender pauses accrual. */
export async function pauseFlow(
  transport: Transport,
  sender: string,
  streamId: string,
  params: PauseFlowParams,
  actAs: string[],
  logger: Logger,
): Promise<{ newFlowCid: string }> {
  return exerciseFlowChoice(transport, sender, streamId, buildPauseFlow(params), actAs, logger);
}

/** Sender resumes accrual. */
export async function resumeFlow(
  transport: Transport,
  sender: string,
  streamId: string,
  params: ResumeFlowParams,
  actAs: string[],
  logger: Logger,
): Promise<{ newFlowCid: string }> {
  return exerciseFlowChoice(transport, sender, streamId, buildResumeFlow(params), actAs, logger);
}

/** Mutual termination — final accrual settled, remainder refunded. */
export async function stopFlow(
  transport: Transport,
  sender: string,
  streamId: string,
  params: StopFlowParams,
  actAs: string[],
  logger: Logger,
): Promise<{ newFlowCid: string }> {
  return exerciseFlowChoice(transport, sender, streamId, buildStopFlow(params), actAs, logger);
}

/**
 * List active StreamFlow contracts visible to the acting parties, with
 * optional filtering. Mirrors `listStreams` — a missing template (DAR
 * not deployed) yields an empty list rather than an error.
 */
export async function listFlows(
  transport: Transport,
  filter: FlowFilter | undefined,
  actAs: string[],
  readAs: string[] | undefined,
  logger: Logger,
): Promise<FlowInfo[]> {
  logger.debug({ filter }, 'Listing flows');

  let flows: FlowInfo[] = [];
  try {
    const results = await transport.query<any>(TEMPLATE_STREAM_FLOW, undefined, actAs, readAs);
    flows = results.map((raw: any) => deserializeFlowContract(raw));
  } catch {
    // Template might not be deployed yet; report no flows.
    return [];
  }

  if (filter) {
    if (filter.sender) flows = flows.filter((f) => f.sender === filter.sender);
    if (filter.recipient) flows = flows.filter((f) => f.recipient === filter.recipient);
    if (filter.status) flows = flows.filter((f) => f.status === filter.status);
  }

  logger.debug({ count: flows.length }, 'Flows listed');
  return flows;
}

/** Get a specific flow by (sender, streamId). Throws when not found. */
export async function getFlow(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  logger: Logger,
): Promise<FlowInfo> {
  const flows = await listFlows(transport, { sender }, actAs, undefined, logger);
  const flow = flows.find((f) => f.sender === sender && f.streamId === streamId);
  if (!flow) {
    throw new Error(`Flow not found: sender=${sender}, streamId=${streamId}`);
  }
  return flow;
}

async function exerciseFlowChoice(
  transport: Transport,
  sender: string,
  streamId: string,
  payload: FlowExercisePayload,
  actAs: string[],
  logger: Logger,
): Promise<{ newFlowCid: string }> {
  const flow = await getFlow(transport, sender, streamId, actAs, logger);
  logger.info(
    { sender, streamId, contractId: flow.contractId, choice: payload.choiceName },
    'Exercising StreamFlow choice',
  );
  const result = (await transport.exercise(
    payload.templateId,
    flow.contractId,
    payload.choiceName,
    payload.argument,
    actAs,
  )) as { contractId?: string } | string;
  // All flow choices return ContractId StreamFlow; transports surface it
  // either as a bare string or wrapped in { contractId }.
  const newFlowCid =
    typeof result === 'string' ? result : (result?.contractId ?? '');
  return { newFlowCid };
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

function deserializeFlowContract(raw: any): FlowInfo {
  return {
    contractId: raw.contractId ?? raw.contract_id ?? '',
    streamId: raw.streamId ?? '',
    sender: raw.sender ?? '',
    recipient: raw.recipient ?? '',
    escrowOperator: raw.escrowOperator ?? '',
    instrumentRef: {
      depository: raw.instrumentRef?.depository ?? '',
      issuer: raw.instrumentRef?.issuer ?? '',
      instrumentId: raw.instrumentRef?.instrumentId ?? '',
      instrumentVersion: raw.instrumentRef?.instrumentVersion ?? '',
    },
    flowRate: new Decimal(raw.flowRate ?? '0'),
    startTime: deserializeTime(raw.startTime),
    fundedAmount: new Decimal(raw.fundedAmount ?? '0'),
    totalWithdrawn: new Decimal(raw.totalWithdrawn ?? '0'),
    status: deserializeFlowStatus(raw.status),
    pausedAt: deserializeOptionalTime(raw.pausedAt),
    cumulativePausedMicros: deserializeRelTime(raw.cumulativePausedDuration),
    lastSettlementReference: deserializeOptionalText(raw.lastSettlementReference),
    numIterations: Number(raw.numIterations ?? 0),
    observers: Array.isArray(raw.observers) ? raw.observers : [],
  };
}

function deserializeFlowStatus(raw: any): FlowStatus {
  const tag =
    typeof raw === 'string'
      ? raw
      : (raw?.tag ?? raw?.variant_constructor ?? raw?.constructor ?? '');
  if (tag === 'FlowPaused' || tag === 'FlowStopped') return tag;
  return 'FlowActive';
}

/** Daml Time arrives as ISO string, micros-since-epoch string, or proto Timestamp. */
function deserializeTime(raw: any): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) return new Date(Number(BigInt(raw) / 1000n));
    return new Date(raw);
  }
  if (typeof raw === 'object' && raw !== null && 'seconds' in raw) {
    const seconds = BigInt(raw.seconds);
    const nanos = raw.nanos ?? 0;
    return new Date(Number(seconds * 1000n) + Math.floor(nanos / 1_000_000));
  }
  if (typeof raw === 'number') return new Date(raw);
  return new Date(raw);
}

function deserializeOptionalTime(raw: any): Date | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (raw?.tag === 'None') return undefined;
  if (raw?.tag === 'Some') return deserializeTime(raw.value);
  return deserializeTime(raw);
}

function deserializeOptionalText(raw: any): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (raw?.tag === 'None') return undefined;
  if (raw?.tag === 'Some') return String(raw.value);
  if (typeof raw === 'object' && 'text' in raw) return String(raw.text);
  return String(raw);
}

function deserializeRelTime(raw: any): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw);
  if (typeof raw === 'object' && raw !== null) {
    if ('microseconds' in raw) return deserializeRelTime(raw.microseconds);
    if ('int64' in raw) return Number(raw.int64);
  }
  return Number(raw ?? 0);
}
