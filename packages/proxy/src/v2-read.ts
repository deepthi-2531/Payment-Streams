/**
 * JSON Ledger API reads for the V2 lane.
 *
 * The SDK's gRPC transport is not functional on this deployment (the proxy
 * can't establish a gRPC connection to the participant's ledger API), so every
 * `CantonStreamsClient` read silently returns `[]` / errors and the dashboard's
 * V2 pages show empty. The JSON Ledger API (same participant, HTTP) IS
 * reachable — the V1 lane uses it — so this reads the V2 contracts over JSON
 * and decodes them into the SDK's serialized shapes, identical to what the
 * (broken) gRPC path would have produced.
 *
 * Only reads live here; writes are in v2-write.ts. All decode helpers tolerate
 * the DA-JSON wire form: parties are plain strings, Decimals are numeric
 * strings, Daml Time is an ISO string (or micros text), RelTime is
 * `{ microseconds }`, variants are `{ tag, value }`, enums are bare strings.
 */

const JSON_API = (process.env['CANTON_JSON_API_URL'] ?? 'http://127.0.0.1:7575').replace(/\/+$/, '');
const LEDGER_TOKEN = process.env['CANTON_LEDGER_TOKEN'];

// canton-streams template name-refs (resolve to the vetted 1.1.0 package).
const STREAM_ADMIN_TID = '#canton-streams:CantonStreams.Stream.StreamAdmin:StreamAdmin';
const STREAM_ESCROW_TID = '#canton-streams:CantonStreams.Stream.Escrow:StreamEscrow';
// Deployed 1.1.0 carries StreamFlowAdmin (observability-only, signatory sender);
// the legacy StreamFlow template is queried too where it still exists.
const STREAMFLOW_ADMIN_TID = '#canton-streams:CantonStreams.Stream.StreamFlowAdmin:StreamFlowAdmin';
const STREAMFLOW_TID = '#canton-streams:CantonStreams.Stream.StreamFlow:StreamFlow';
const CREATE_REQUEST_TID = '#canton-streams:CantonStreams.Workflow.CreateStream:CreateStreamRequest';
const DELEGATED_POLICY_TID = '#canton-streams:CantonStreams.Policy.DelegatedPolicy:DelegatedPolicy';
// ExecutionLog lives in the DelegatedPolicy module.
const EXECUTION_LOG_TID = '#canton-streams:CantonStreams.Policy.DelegatedPolicy:ExecutionLog';

export interface StreamReadFilter {
  sender?: string;
  recipient?: string;
  status?: string;
  vestingMode?: string;
}

export async function jsonLedger(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (LEDGER_TOKEN) headers['Authorization'] = `Bearer ${LEDGER_TOKEN}`;
  const res = await fetch(`${JSON_API}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`json-ledger ${path} ${res.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

/** Daml Time (ISO string, or microseconds-since-epoch text) → ISO string. */
export function toIso(t: unknown): string {
  if (t == null) return new Date(0).toISOString();
  if (typeof t === 'string') {
    if (/^\d+$/.test(t)) return new Date(Number(BigInt(t) / 1000n)).toISOString();
    return new Date(t).toISOString();
  }
  return new Date(t as number).toISOString();
}

/** Optional Daml Time → ISO string or undefined. */
function optIso(t: any): string | undefined {
  if (t == null) return undefined;
  if (t?.tag === 'Some') return toIso(t.value);
  if (typeof t === 'object' && 'value' in t) return toIso(t.value);
  return toIso(t);
}

/** Daml RelTime ({ microseconds }) → number of microseconds. */
function relTimeMicros(v: any): number {
  return Number(v?.microseconds ?? v ?? 0);
}

/** Optional Daml Text → string or undefined. */
function optText(v: any): string | undefined {
  if (v == null) return undefined;
  if (v?.tag === 'Some') return String(v.value);
  if (typeof v === 'object' && 'value' in v) return String(v.value);
  return String(v);
}

/** Daml VestingMode variant → the SDK's serialized VestingModeConfig. */
function vestingModeConfig(vm: any): Record<string, unknown> {
  const tag = vm?.tag ?? vm?.variant_constructor ?? (typeof vm === 'string' ? vm : 'Linear');
  const value = vm?.value ?? {};
  switch (tag) {
    case 'CliffLinear':
      return { mode: 'CliffLinear', cliffTime: toIso(value.cliffTime) };
    case 'Stepped':
      return {
        mode: 'Stepped',
        stepInterval: relTimeMicros(value?.stepInterval),
        amountPerStep: String(value?.amountPerStep ?? '0'),
      };
    case 'RenewableTerm':
      return { mode: 'RenewableTerm', termDuration: relTimeMicros(value?.termDuration) };
    default:
      return { mode: 'Linear' };
  }
}

/**
 * Core primitive shared by every read: query one template's active contracts
 * for `party` over the JSON Ledger API and map each row through `decodeFn`.
 */
export async function listActiveContractsViaJson(
  party: string | undefined,
  templateNameRef: string,
  decodeFn: (createArgument: any, contractId: string) => Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  if (!party) return [];
  const { offset } = await jsonLedger('GET', '/v2/state/ledger-end');
  const rows: any[] = await jsonLedger('POST', '/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: { value: { templateId: templateNameRef, includeCreatedEventBlob: false } },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: offset,
  });
  return rows
    .map((r) => r?.contractEntry?.JsActiveContract?.createdEvent)
    .filter(Boolean)
    .map((ev: any) => decodeFn(ev.createArgument ?? {}, ev.contractId));
}

// ---------------------------------------------------------------------------
// Decoders — DA-JSON createArgument → the SDK's serialized shape
// ---------------------------------------------------------------------------

/** StreamAdmin → serialized Stream. instrumentId {admin,id} → InstrumentRef. */
function decodeStreamAdmin(ca: any, contractId: string): Record<string, unknown> {
  const instrumentRef = {
    depository: '',
    issuer: ca?.instrumentId?.admin ?? '',
    instrumentId: ca?.instrumentId?.id ?? '',
    instrumentVersion: '',
  };
  const total = String(ca?.totalDeposited ?? '0');
  const withdrawn = String(ca?.totalWithdrawn ?? '0');
  const status = typeof ca?.status === 'string' ? ca.status : (ca?.status?.tag ?? 'Active');
  return {
    contractId,
    config: {
      streamId: ca?.streamId,
      sender: ca?.sender,
      recipient: ca?.recipient,
      totalDeposited: total,
      startTime: toIso(ca?.startTime),
      endTime: toIso(ca?.endTime),
      vestingMode: vestingModeConfig(ca?.vestingMode),
      assetType: 'GlobalCip56',
      instrumentRef,
      cancellable: ca?.cancellable ?? true,
      settlementMode: 'TokenStandardCustody',
    },
    state: { totalWithdrawn: withdrawn, status, renewalCount: Number(ca?.numIterations ?? 0) },
    escrowRef: {
      escrowHoldingCid: ca?.currentAllocationCid ?? '',
      escrowAmount: (Number(total) - Number(withdrawn)).toFixed(10),
      escrowOperator: ca?.operator ?? '',
      instrumentRef,
      recipientAccount: {},
      fundingReference: ca?.originalAllocationId ?? undefined,
      lastSettlementReference: ca?.currentAllocationCid ?? undefined,
    },
  };
}

/** CreateStreamRequest → serialized PendingStreamRequest (config nested). */
function decodePendingRequest(ca: any, contractId: string): Record<string, unknown> {
  const cfg = ca?.config ?? ca ?? {};
  const ir = cfg?.instrumentRef;
  return {
    contractId,
    config: {
      streamId: cfg?.streamId,
      sender: cfg?.sender,
      recipient: cfg?.recipient,
      totalDeposited: String(cfg?.totalDeposited ?? '0'),
      startTime: toIso(cfg?.startTime),
      endTime: toIso(cfg?.endTime),
      vestingMode: vestingModeConfig(cfg?.vestingMode),
      assetType: cfg?.assetType ?? 'GlobalCip56',
      instrumentRef: ir
        ? {
            depository: ir.depository ?? '',
            issuer: ir.issuer ?? '',
            instrumentId: ir.instrumentId ?? '',
            instrumentVersion: ir.instrumentVersion ?? '',
          }
        : undefined,
      cancellable: cfg?.cancellable ?? false,
      settlementMode: 'NumericLegacy',
    },
    recipientAccount: undefined,
    observers: Array.isArray(ca?.observers) ? ca.observers : [],
    settlementMode: 'NumericLegacy',
  };
}

/**
 * StreamFlowAdmin → serialized FlowInfo. The admin/observability template
 * (`instrumentId {admin,id}`, `operator`, `currentFundedAmount`, `paused` +
 * StreamStatus) maps onto the dashboard's flat FlowInfo shape; the FlowStatus
 * enum is synthesized from `status` + `paused`.
 */
function decodeFlowAdmin(ca: any, contractId: string): Record<string, unknown> {
  const streamStatus = typeof ca?.status === 'string' ? ca.status : (ca?.status?.tag ?? 'Active');
  const paused = ca?.paused === true;
  const flowStatus = streamStatus === 'Cancelled' || streamStatus === 'Completed'
    ? 'FlowStopped'
    : paused
      ? 'FlowPaused'
      : 'FlowActive';
  return {
    contractId,
    streamId: ca?.streamId ?? '',
    sender: ca?.sender ?? '',
    recipient: ca?.recipient ?? '',
    escrowOperator: ca?.operator ?? '',
    instrumentRef: {
      depository: '',
      issuer: ca?.instrumentId?.admin ?? '',
      instrumentId: ca?.instrumentId?.id ?? '',
      instrumentVersion: '',
    },
    flowRate: String(ca?.flowRate ?? '0'),
    startTime: toIso(ca?.startTime),
    fundedAmount: String(ca?.currentFundedAmount ?? '0'),
    totalWithdrawn: String(ca?.totalWithdrawn ?? '0'),
    status: flowStatus,
    pausedAt: undefined,
    cumulativePausedMicros: 0,
    lastSettlementReference: optText(ca?.currentAllocationCid),
    numIterations: Number(ca?.numIterations ?? 0),
    observers: Array.isArray(ca?.observers) ? ca.observers : [],
  };
}

/** Legacy StreamFlow → serialized FlowInfo (flat fields, full instrumentRef). */
function decodeFlow(ca: any, contractId: string): Record<string, unknown> {
  return {
    contractId,
    streamId: ca?.streamId ?? '',
    sender: ca?.sender ?? '',
    recipient: ca?.recipient ?? '',
    escrowOperator: ca?.escrowOperator ?? '',
    instrumentRef: {
      depository: ca?.instrumentRef?.depository ?? '',
      issuer: ca?.instrumentRef?.issuer ?? '',
      instrumentId: ca?.instrumentRef?.instrumentId ?? '',
      instrumentVersion: ca?.instrumentRef?.instrumentVersion ?? '',
    },
    flowRate: String(ca?.flowRate ?? '0'),
    startTime: toIso(ca?.startTime),
    fundedAmount: String(ca?.fundedAmount ?? '0'),
    totalWithdrawn: String(ca?.totalWithdrawn ?? '0'),
    status: typeof ca?.status === 'string' ? ca.status : (ca?.status?.tag ?? 'FlowActive'),
    pausedAt: optIso(ca?.pausedAt),
    cumulativePausedMicros: relTimeMicros(ca?.cumulativePausedDuration),
    lastSettlementReference: optText(ca?.lastSettlementReference),
    numIterations: Number(ca?.numIterations ?? 0),
    observers: Array.isArray(ca?.observers) ? ca.observers : [],
  };
}

/** DelegatedPolicy → serialized PolicyInfo (RelTime→micros, Time→ISO). */
function decodePolicy(ca: any, contractId: string): Record<string, unknown> {
  return {
    contractId,
    policyId: ca?.policyId ?? '',
    sender: ca?.sender ?? '',
    recipient: ca?.recipient ?? '',
    executor: ca?.executor ?? '',
    escrowOperator: ca?.escrowOperator ?? '',
    allowedActions: Array.isArray(ca?.allowedActions)
      ? ca.allowedActions.map((a: any) => (typeof a === 'string' ? a : a?.tag ?? a?.variant_constructor ?? ''))
      : [],
    rateLimit: {
      maxExecutionsPerPeriod: Number(ca?.rateLimit?.maxExecutionsPerPeriod ?? 0),
      periodDuration: relTimeMicros(ca?.rateLimit?.periodDuration),
      maxAmountPerExecution: String(ca?.rateLimit?.maxAmountPerExecution ?? '0'),
      cooldownInterval: relTimeMicros(ca?.rateLimit?.cooldownInterval),
    },
    streamFilters: Array.isArray(ca?.streamFilters) ? ca.streamFilters : [],
    active: ca?.active ?? false,
    expiresAt: toIso(ca?.expiresAt),
    createdAt: toIso(ca?.createdAt),
  };
}

/** ExecutionLog → serialized ExecutionLogInfo. */
function decodeExecutionLog(ca: any, contractId: string): Record<string, unknown> {
  return {
    contractId,
    policyId: ca?.policyId ?? '',
    executionId: ca?.executionId ?? '',
    sender: ca?.sender ?? '',
    executor: ca?.executor ?? '',
    targetStreamId: ca?.targetStreamId ?? '',
    action: typeof ca?.action === 'string' ? ca.action : (ca?.action?.tag ?? ''),
    amount: String(ca?.amount ?? '0'),
    executionTime: toIso(ca?.executionTime),
    success: ca?.success ?? false,
    errorMessage: optText(ca?.errorMessage),
  };
}

// ---------------------------------------------------------------------------
// Public read API — one function per V2 GET endpoint
// ---------------------------------------------------------------------------

export async function listStreamsViaJson(
  party: string | undefined,
  filter: StreamReadFilter = {},
): Promise<Array<Record<string, unknown>>> {
  const admin = await listActiveContractsViaJson(party, STREAM_ADMIN_TID, decodeStreamAdmin);
  const escrow = await listActiveContractsViaJson(party, STREAM_ESCROW_TID, decodeStreamAdmin).catch(() => []);
  let streams = [...admin, ...escrow];
  if (filter.sender) streams = streams.filter((s: any) => s.config.sender === filter.sender);
  if (filter.recipient) streams = streams.filter((s: any) => s.config.recipient === filter.recipient);
  if (filter.status) streams = streams.filter((s: any) => s.state.status === filter.status);
  if (filter.vestingMode) streams = streams.filter((s: any) => s.config.vestingMode.mode === filter.vestingMode);
  return streams;
}

/** One stream by (sender, streamId), or undefined. */
export async function getStreamViaJson(
  party: string | undefined,
  sender: string,
  streamId: string,
): Promise<Record<string, unknown> | undefined> {
  const streams = await listStreamsViaJson(party, {});
  return streams.find((s: any) => s.config.sender === sender && s.config.streamId === streamId);
}

/** One StreamFlow by (sender, flowId), or undefined — for write-path lookups. */
export async function getFlowViaJson(
  party: string | undefined,
  sender: string,
  flowId: string,
): Promise<Record<string, unknown> | undefined> {
  const flows = await listFlowsViaJson(party);
  return flows.find((f: any) => f.sender === sender && f.streamId === flowId);
}

/**
 * Synthesize a stream's event history from its current on-ledger state — the
 * SDK's `getStateBasedHistory` layer (created / withdrawn / completed /
 * cancelled / renewed, all `source:'state'`). The richer ledger-sourced
 * history needs /v2/updates trees and is a separate follow-up.
 */
export function synthesizeStreamHistory(stream: any): Array<Record<string, unknown>> {
  if (!stream) return [];
  const cfg = stream.config ?? {};
  const st = stream.state ?? {};
  const events: Array<Record<string, unknown>> = [
    {
      type: 'created',
      contractId: stream.contractId,
      timestamp: cfg.startTime,
      source: 'state',
      payload: {
        sender: cfg.sender,
        recipient: cfg.recipient,
        totalDeposited: String(cfg.totalDeposited ?? '0'),
        vestingMode: cfg.vestingMode?.mode ?? 'Linear',
      },
    },
  ];
  if (Number(st.totalWithdrawn ?? 0) > 0) {
    events.push({
      type: 'withdrawn',
      contractId: stream.contractId,
      timestamp: cfg.startTime,
      source: 'state',
      payload: { amountWithdrawn: String(st.totalWithdrawn), newTotalWithdrawn: String(st.totalWithdrawn) },
    });
  }
  if (st.status === 'Completed') {
    events.push({ type: 'completed', contractId: stream.contractId, timestamp: cfg.endTime, source: 'state', payload: {} });
  } else if (st.status === 'Cancelled') {
    events.push({ type: 'cancelled', contractId: stream.contractId, timestamp: cfg.startTime, source: 'state', payload: {} });
  }
  if (Number(st.renewalCount ?? 0) > 0) {
    events.push({
      type: 'renewed',
      contractId: stream.contractId,
      timestamp: cfg.startTime,
      source: 'state',
      payload: { renewalCount: Number(st.renewalCount) },
    });
  }
  return events;
}

export function listPendingRequestsViaJson(party: string | undefined): Promise<Array<Record<string, unknown>>> {
  return listActiveContractsViaJson(party, CREATE_REQUEST_TID, decodePendingRequest);
}

export async function listFlowsViaJson(party: string | undefined): Promise<Array<Record<string, unknown>>> {
  const admin = await listActiveContractsViaJson(party, STREAMFLOW_ADMIN_TID, decodeFlowAdmin).catch(() => []);
  const legacy = await listActiveContractsViaJson(party, STREAMFLOW_TID, decodeFlow).catch(() => []);
  return [...admin, ...legacy];
}

export function listPoliciesViaJson(party: string | undefined): Promise<Array<Record<string, unknown>>> {
  return listActiveContractsViaJson(party, DELEGATED_POLICY_TID, decodePolicy);
}

export function listExecutionLogsViaJson(party: string | undefined): Promise<Array<Record<string, unknown>>> {
  return listActiveContractsViaJson(party, EXECUTION_LOG_TID, decodeExecutionLog);
}
