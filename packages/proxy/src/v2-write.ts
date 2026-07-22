/**
 * JSON Ledger API writes for the V2 lane.
 *
 * The SDK's gRPC transport can't reach the participant on this deploy, so
 * `CantonStreamsClient` submits fail. These submit the same commands over the
 * JSON Ledger API `/v2/commands/submit-and-wait` (proven working — the V1 lane
 * + the StreamAdmin create use it).
 *
 * Commands MUST be built in PLAIN DA-JSON (party → bare string, Decimal →
 * `toFixed(10)` string, Daml Time → micros/ISO string, variant → `{ tag, value }`,
 * enum → bare constructor string, Optional → value | null). Do NOT feed the SDK's
 * `build*Create` output here — it emits gRPC-tagged `{ party }`/`{ numeric }`/
 * `{ timestamp }` values the JSON API rejects.
 */

import Decimal from 'decimal.js';
import { jsonLedger } from './v2-read.js';

const USER_ID = process.env['CANTON_USER_ID'] || process.env['CANTON_LEDGER_USER'] || 'administrator';

let submitCounter = 0;

/** Submit one or more commands as `actAs` and return the ledger response. */
export async function submitViaJson(
  tag: string,
  actAs: string[],
  commands: unknown[],
): Promise<any> {
  return jsonLedger('POST', '/v2/commands/submit-and-wait', {
    commands,
    commandId: `proxy-v2-${tag}-${Date.now()}-${++submitCounter}`,
    actAs,
    readAs: [],
    ...(USER_ID ? { userId: USER_ID } : {}),
  });
}

export function createCommand(templateId: string, createArguments: Record<string, unknown>): unknown {
  return { CreateCommand: { templateId, createArguments } };
}

export function exerciseCommand(
  templateId: string,
  contractId: string,
  choice: string,
  choiceArgument: Record<string, unknown>,
): unknown {
  return { ExerciseCommand: { templateId, contractId, choice, choiceArgument } };
}

/** Decimal → fixed-10 string (the DA-JSON numeric form the JSON API expects).
 * Formats through decimal.js, not JS `Number`, so amounts near/above 2^53 keep
 * full Numeric-10 precision at the ledger-write boundary. */
export function dec(x: unknown): string {
  return new Decimal((x ?? 0) as Decimal.Value).toFixed(10);
}

const STREAM_ADMIN_TID = '#canton-streams:CantonStreams.Stream.StreamAdmin:StreamAdmin';
const STREAMFLOW_ADMIN_TID = '#canton-streams:CantonStreams.Stream.StreamFlowAdmin:StreamFlowAdmin';
const DELEGATED_POLICY_TID = '#canton-streams:CantonStreams.Policy.DelegatedPolicy:DelegatedPolicy';

/** Extract a real on-ledger updateId from a submit-and-wait response. */
export function updateIdOf(res: any): string | undefined {
  return (res?.updateId ?? res?.transactionTree?.updateId ?? res?.transaction?.updateId) as string | undefined;
}

// ---------------------------------------------------------------------------
// V2 stream create (StreamAdmin) — proven over JSON
// ---------------------------------------------------------------------------

export interface CreateStreamAdminInput {
  streamId: string;
  sender: string;
  recipient: string;
  operator: string;
  instrumentAdmin: string; // DSO party (instrumentRef.issuer)
  instrumentId: string; // "Amulet"
  totalDeposited: string | number;
  vestingMode: Record<string, unknown>; // DA-JSON { tag, value }
  startTime: Date | string;
  endTime: Date | string;
  cancellable: boolean;
}

/** Daml Time over the JSON Ledger API is an ISO-8601 string (NOT raw micros). */
function toIsoStr(t: Date | string): string {
  const ms = t instanceof Date ? t.getTime() : Date.parse(String(t));
  return new Date(ms).toISOString();
}

/** SDK VestingModeConfig ({ mode, ... }) → DA-JSON variant { tag, value }. */
export function vestingModeToDaJson(vm: any): Record<string, unknown> {
  switch (vm?.mode) {
    case 'CliffLinear':
      return { tag: 'CliffLinear', value: { cliffTime: toIsoStr(vm.cliffTime) } };
    case 'Stepped':
      return {
        tag: 'Stepped',
        value: {
          stepInterval: { microseconds: String(vm.stepInterval ?? 0) },
          amountPerStep: dec(vm.amountPerStep),
        },
      };
    case 'RenewableTerm':
      return { tag: 'RenewableTerm', value: { termDuration: { microseconds: String(vm.termDuration ?? 0) } } };
    default:
      return { tag: 'Linear', value: {} };
  }
}

/**
 * Create a V2 StreamAdmin over JSON. StreamAdmin 1.1.0 `signatory sender`
 * (`observer recipient, operator`), so `actAs=[sender]` suffices when the
 * sender is hosted on this participant.
 */
export async function createStreamAdminViaJson(input: CreateStreamAdminInput): Promise<{ updateId: string }> {
  const createArguments = {
    streamId: input.streamId,
    sender: input.sender,
    recipient: input.recipient,
    operator: input.operator,
    instrumentId: { admin: input.instrumentAdmin, id: input.instrumentId },
    totalDeposited: dec(input.totalDeposited),
    vestingMode: input.vestingMode,
    startTime: toIsoStr(input.startTime),
    endTime: toIsoStr(input.endTime),
    cancellable: input.cancellable,
    totalWithdrawn: dec(0),
    numIterations: '0',
    status: 'Active',
    currentAllocationCid: null,
    originalAllocationId: null,
    observers: [],
  };
  const res = await submitViaJson('create-admin', [input.sender], [createCommand(STREAM_ADMIN_TID, createArguments)]);
  const updateId = updateIdOf(res);
  if (!updateId) throw new Error('createStream submitted but the ledger returned no updateId');
  return { updateId };
}

// ---------------------------------------------------------------------------
// V2 open-ended flow (StreamFlowAdmin) — observability-only bookkeeping.
//
// StreamFlowAdmin is `signatory sender`, so create is actAs=[sender]. The
// lifecycle choices (TopUp_Flow_Admin / Sync_Iteration_Flow / Pause / Resume /
// Mark_Cancelled_Flow_Admin) are `controller operator` and purely archive +
// recreate the index record — no allocation dependency — so they submit over
// JSON as actAs=[operator]. The actual Amulet money movement (Allocation_Settle)
// stays DSO-blocked and is surfaced separately in the UI.
// ---------------------------------------------------------------------------

export interface CreateFlowAdminInput {
  streamId: string;
  sender: string;
  recipient: string;
  operator: string;
  instrumentAdmin: string; // DSO party (instrumentRef.issuer)
  instrumentId: string; // "Amulet"
  flowRate: string | number; // tokens per microsecond
  initialFundedAmount: string | number;
  startTime: Date | string;
  observers?: string[];
}

/** Create a V2 StreamFlowAdmin over JSON (signatory sender → actAs=[sender]). */
export async function createFlowAdminViaJson(input: CreateFlowAdminInput): Promise<{ updateId: string }> {
  const createArguments = {
    streamId: input.streamId,
    sender: input.sender,
    recipient: input.recipient,
    operator: input.operator,
    instrumentId: { admin: input.instrumentAdmin, id: input.instrumentId },
    flowRate: dec(input.flowRate),
    startTime: toIsoStr(input.startTime),
    currentFundedAmount: dec(input.initialFundedAmount),
    totalWithdrawn: dec(0),
    numIterations: '0',
    paused: false,
    status: 'Active',
    currentAllocationCid: null,
    originalAllocationId: null,
    observers: input.observers ?? [],
  };
  const res = await submitViaJson('create-flow-admin', [input.sender], [
    createCommand(STREAMFLOW_ADMIN_TID, createArguments),
  ]);
  const updateId = updateIdOf(res);
  if (!updateId) throw new Error('createFlow submitted but the ledger returned no updateId');
  return { updateId };
}

/** Record a top-up on a StreamFlowAdmin (TopUp_Flow_Admin, controller operator). */
export async function topUpFlowAdminViaJson(
  contractId: string,
  operator: string,
  topUpAmount: string | number,
  newAllocationCid?: string,
): Promise<{ updateId: string }> {
  const res = await submitViaJson('topup-flow-admin', [operator], [
    exerciseCommand(STREAMFLOW_ADMIN_TID, contractId, 'TopUp_Flow_Admin', {
      topUpAmount: dec(topUpAmount),
      newAllocationCid: newAllocationCid ?? null,
    }),
  ]);
  const updateId = updateIdOf(res);
  if (!updateId) throw new Error('topUpFlow submitted but the ledger returned no updateId');
  return { updateId };
}

/**
 * Record a settle iteration on a StreamFlowAdmin (Sync_Iteration_Flow,
 * controller operator). Pure bookkeeping: advances numIterations/totalWithdrawn.
 * The contract flow-rate-caps `iterationAmount` at `flowRate * elapsed`, so an
 * overshoot is rejected on-ledger. The Amulet transfer itself is DSO-blocked.
 */
export async function syncIterationFlowViaJson(
  contractId: string,
  operator: string,
  iterationAmount: string | number,
  newAllocationCid?: string,
): Promise<{ updateId: string }> {
  const res = await submitViaJson('sync-iteration-flow', [operator], [
    exerciseCommand(STREAMFLOW_ADMIN_TID, contractId, 'Sync_Iteration_Flow', {
      iterationAmount: dec(iterationAmount),
      newAllocationCid: newAllocationCid ?? null,
      expectedIteration: null,
      settledAt: null,
    }),
  ]);
  const updateId = updateIdOf(res);
  if (!updateId) throw new Error('withdrawFlow submitted but the ledger returned no updateId');
  return { updateId };
}

/** Mark a StreamFlowAdmin cancelled (Mark_Cancelled_Flow_Admin, controller operator). */
export async function markCancelledFlowAdminViaJson(
  contractId: string,
  operator: string,
  finalWithdrawn: string | number,
  cancelTime: Date | string,
  releasedAllocationCid?: string,
): Promise<{ updateId: string }> {
  const res = await submitViaJson('cancel-flow-admin', [operator], [
    exerciseCommand(STREAMFLOW_ADMIN_TID, contractId, 'Mark_Cancelled_Flow_Admin', {
      cancelTime: toIsoStr(cancelTime),
      finalWithdrawn: dec(finalWithdrawn),
      releasedAllocationCid: releasedAllocationCid ?? null,
    }),
  ]);
  const updateId = updateIdOf(res);
  if (!updateId) throw new Error('stopFlow submitted but the ledger returned no updateId');
  return { updateId };
}

// ---------------------------------------------------------------------------
// Policy revoke — single-controller exercise, no allocation dependency
// ---------------------------------------------------------------------------

/** Exercise RevokePolicy on a DelegatedPolicy (controller = policy sender). */
export async function revokePolicyViaJson(contractId: string, sender: string): Promise<{ updateId: string }> {
  const res = await submitViaJson('revoke-policy', [sender], [
    exerciseCommand(DELEGATED_POLICY_TID, contractId, 'RevokePolicy', {}),
  ]);
  const updateId = updateIdOf(res);
  if (!updateId) throw new Error('revokePolicy submitted but the ledger returned no updateId');
  return { updateId };
}
