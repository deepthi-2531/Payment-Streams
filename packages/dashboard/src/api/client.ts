/**
 * REST API client for the Canton Streams proxy.
 *
 * Replaces direct SDK usage (which requires Node.js) with fetch-based
 * calls to the proxy server. All Decimal values are serialized as
 * strings over the wire and reconstructed on the client side.
 *
 * Hosted-wallet read path (STR-83 / STR-123 follow-up):
 *
 * When the user is signed in via a hosted-multi-wallet (PartyLayer →
 * 5N Loop, Cantor8, Send), the dashboard never receives a JWT — the
 * wallet signs and routes ledger calls through its own server-side
 * proxy. There is no `Authorization: Bearer <jwt>` to send to our
 * REST proxy, and asking our proxy to "log in" on the user's behalf
 * isn't possible without per-wallet integration.
 *
 * In that case the client SHORT-CIRCUITS proxy reads: each read
 * method first probes the wallet's CIP-0103 `ledgerApi` to verify
 * the wallet-routed ledger path is alive, then returns an empty
 * result set. Empty is the truthful answer because our Canton Streams
 * DAR is not deployed to the devnet participant the picked wallet is
 * attached to (Loop on devnet has zero StreamEscrow contracts for the
 * user, by construction).
 *
 * What this DOES give us:
 *   - No more 500 / Internal Server Error when the proxy is absent.
 *   - The dashboard renders 0-stream / 0-policy / 0-pending states
 *     cleanly through Skeleton → empty UI.
 *   - The wallet's `ledgerApi` round-trip is exercised, so when the
 *     DAR ships to a network the wallet can reach, the full decoder
 *     (next step) can swap in here.
 *
 * What the FOLLOW-UP must do:
 *   - Replace the `[]` payloads with a real Ledger-API decoder that
 *     queries by template-id (TEMPLATE_STREAM_ESCROW etc.) via
 *     walletClient.ledgerApi and reuses the SDK's browser-safe Stream
 *     deserializers. Tracked as the STR-83 + STR-123 ledger-routing
 *     work; documented in docs/HOSTED-WALLET-PLAN.md.
 *   - Writes (createStream / accept / withdraw / cancel / renew /
 *     revokePolicy) still throw a clear error today — the wallet
 *     would need to drive `prepareExecuteAndWait` on a real
 *     AllocationRequest, which is gated behind the SDK adding that
 *     method (capabilities.prepareExecuteAndWait flips to true).
 */

import Decimal from 'decimal.js';
import type {
  Stream,
  StreamConfig,
  StreamState,
  StreamFilter,
  PendingStreamRequest,
  PendingStreamRequestFilter,
  StreamEvent,
  CreateStreamParams,
  RenewParams,
  WithdrawResult,
  CancelResult,
  VestingModeConfig,
  LedgerRecord,
} from '@canton-streams/sdk/browser';
import { VestingMode, StreamStatus, AssetType, SettlementMode } from '@canton-streams/sdk/browser';
import { walletClient } from '../store/wallet/index.js';

/**
 * Error thrown when a mutation is attempted from a hosted-wallet
 * session that has no path to drive the underlying transaction.
 * Surfaced to the user via the mutation handler.
 */
export class HostedWalletWriteUnsupportedError extends Error {
  constructor(action: string) {
    super(
      `${action} is not yet wired for hosted wallets (5N Loop, Cantor8, Send). ` +
        `It requires routing the Daml command through ` +
        `walletClient.prepareExecuteAndWait — that capability is currently false ` +
        `for the PartyLayer-routed Provider. See HOSTED-WALLET-PLAN.md.`,
    );
    this.name = 'HostedWalletWriteUnsupportedError';
  }
}

/**
 * [M7] Optional settlement args for TokenStandardCustody cancel /
 * mutualCancel. Required when the stream is TS-custody; omit for
 * NumericLegacy / UtilityHoldingCustody streams.
 */
export interface TokenStandardCancelArgs {
  readonly recipientSettlementReference?: string;
  readonly senderRefundReference?: string;
  readonly confirmedRecipientAmount?: string;
  readonly confirmedSenderRefund?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CantonStreamsApi {
  // `getParty` retained as a constructor arg for backwards-compat with
  // useCantonClient; not used for request headers anymore (STR-123 Phase
  // 7). Kept so existing call-sites compile + the constructor signature
  // doesn't churn ahead of STR-83 proxy cutover.
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | null,

    _getParty?: () => string | null,
  ) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
    // STR-123 Phase 7: identity is read by the proxy from the wallet-issued
    // bearer token, not from a separate party header. The dashboard no
    // longer sends `X-Canton-Party`. Once STR-83 lands the proxy stops
    // accepting it entirely.
    return h;
  }

  /**
   * True when the active session is a hosted multi-wallet (Loop /
   * Cantor8 / Send / Bron) with no JWT bearer token. Reads in this
   * mode go through `walletClient.ledgerApi` rather than the proxy.
   */
  private isHostedWalletSession(): boolean {
    if (this.getToken()) return false;
    if (!walletClient.capabilities.hostedMultiWallet) return false;
    if (!walletClient.capabilities.ledgerApi) return false;
    return typeof walletClient.ledgerApi === 'function';
  }

  /**
   * Hosted-wallet read path: NO ledger probe today.
   *
   * Earlier iterations of this code tried to exercise the wallet's
   * CIP-0103 `ledgerApi` with a probe query (first `GET /v2/version`,
   * then `GET /v2/state/acs/active-contracts`, then `POST /v2/state/acs`
   * with various filter shapes). All three were rejected by Loop's
   * adapter wrapper — `/v2/version` is not on Loop's allowlist, and
   * the ACS endpoints are rejected as "unfiltered query" no matter
   * what filter shape we send, because Loop's wrapper requires a
   * templateId / interfaceId Canton Streams hasn't deployed to the
   * devnet participant Loop is attached to.
   *
   * The user-visible cost of the failing probe was a banner
   * ("Could not load streams: Loop getActiveContracts() failed for
   * no filter") on every page even though the dashboard had nothing
   * to show. Dropping the probe is the honest answer:
   *
   *   - The dashboard returns `[]` for every hosted-wallet read.
   *   - The CIP-0103 wallet path is genuinely not exercised here.
   *   - The follow-up (browser-side template-filtered decoder) is
   *     what turns this into a real query.
   *
   * When that follow-up lands, the decoder will:
   *   1. resolve the active party from `walletClient.listAccounts()`
   *   2. POST a filtered ACS query for TEMPLATE_STREAM_ESCROW etc.
   *      against the participant the wallet is attached to (the
   *      filter shape that Loop's wrapper actually allows — likely
   *      the templateId-in-query-param form once the streams DAR
   *      is published on a network Loop can reach)
   *   3. reuse the SDK's browser-safe `deserializeStream` decoder.
   *
   * Until then: the hosted-wallet code path is "render the shell
   * truthfully empty". That's better than a noisy banner.
   */
  private async probeHostedLedger(): Promise<void> {
    return;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let err: unknown;
      try {
        err = await res.json();
      } catch {
        // Body wasn't JSON — most likely the dev-server's HTML 5xx
        // page bubbling up because the upstream proxy is not
        // running. Provide an actionable message rather than the
        // bare "Internal Server Error".
        const text = await res.text().catch(() => '');
        if (res.status === 500 && /<html|<!doctype/i.test(text)) {
          throw new Error(
            `Proxy unreachable (HTTP 500 from dev server). ` +
              `Is the @canton-streams/proxy running on the port Vite's ` +
              `dev proxy forwards /api to? See vite.config.ts.`,
          );
        }
        err = { error: text || res.statusText };
      }
      throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  // --- Queries ---

  async listStreams(filter?: StreamFilter): Promise<Stream[]> {
    if (this.isHostedWalletSession()) {
      await this.probeHostedLedger();
      // Empty result is truthful: the Canton Streams DAR is not
      // deployed to the devnet participant the hosted wallet talks
      // to, so there are no StreamEscrow contracts to return. The
      // follow-up step swaps in a real Ledger-API decoder here.
      return [];
    }
    const params = new URLSearchParams();
    if (filter?.sender) params.set('sender', filter.sender);
    if (filter?.recipient) params.set('recipient', filter.recipient);
    if (filter?.status) params.set('status', filter.status);
    if (filter?.vestingMode) params.set('vestingMode', filter.vestingMode);
    const qs = params.toString();
    const raw = await this.request<RawStream[]>('GET', `/api/streams${qs ? `?${qs}` : ''}`);
    return raw.map(deserializeStream);
  }

  async listPendingStreamRequests(
    filter?: PendingStreamRequestFilter,
  ): Promise<PendingStreamRequest[]> {
    if (this.isHostedWalletSession()) {
      await this.probeHostedLedger();
      return [];
    }
    const params = new URLSearchParams();
    if (filter?.sender) params.set('sender', filter.sender);
    if (filter?.recipient) params.set('recipient', filter.recipient);
    if (filter?.assetType) params.set('assetType', filter.assetType);
    const qs = params.toString();
    const raw = await this.request<RawPendingStreamRequest[]>(
      'GET',
      `/api/stream-requests${qs ? `?${qs}` : ''}`,
    );
    return raw.map(deserializePendingStreamRequest);
  }

  async getStream(sender: string, streamId: string): Promise<Stream> {
    if (this.isHostedWalletSession()) {
      // No way to honestly answer "this specific contract id exists"
      // without a real ledger decode. Surface a clear error.
      throw new Error(
        'Single-stream lookup is not yet wired for hosted wallets. ' +
          'Sign in with a dapp-sdk wallet (LocalNet Amulet) to inspect a stream by id.',
      );
    }
    const raw = await this.request<RawStream>(
      'GET',
      `/api/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}`,
    );
    return deserializeStream(raw);
  }

  async getStreamHistory(sender: string, streamId: string): Promise<StreamEvent[]> {
    if (this.isHostedWalletSession()) {
      return [];
    }
    return this.request<StreamEvent[]>(
      'GET',
      `/api/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}/history`,
    );
  }

  // --- Mutations ---

  async createStream(
    params: CreateStreamParams,
  ): Promise<{ requestContractId: string; streamId: string }> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Create stream');
    }
    return this.request('POST', '/api/streams', serializeCreateParams(params));
  }

  async acceptStream(sender: string, streamId: string): Promise<{ escrowContractId: string }> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Accept stream');
    }
    return this.request(
      'POST',
      `/api/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}/accept`,
    );
  }

  async withdraw(sender: string, streamId: string): Promise<WithdrawResult> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Withdraw');
    }
    const raw = await this.request<RawWithdrawResult>(
      'POST',
      `/api/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}/withdraw`,
    );
    return {
      amountWithdrawn: new Decimal(raw.amountWithdrawn),
      newTotalWithdrawn: new Decimal(raw.newTotalWithdrawn),
      newStatus: raw.newStatus as StreamStatus,
    };
  }

  /**
   * [M7] Cancel a stream.
   *
   * For TokenStandardCustody streams, the proxy needs settlement
   * references (recipient + sender refund refs) to validate the
   * orchestrated cancel against on-chain state. Previously this
   * method sent an empty body, causing the proxy's settlement-mode
   * branching to fall into the wrong path for TS-custody streams.
   */
  async cancel(
    sender: string,
    streamId: string,
    settlementArgs?: TokenStandardCancelArgs,
  ): Promise<CancelResult> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Cancel stream');
    }
    const raw = await this.request<RawCancelResult>(
      'POST',
      `/api/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}/cancel`,
      settlementArgs,
    );
    return {
      recipientAmount: new Decimal(raw.recipientAmount),
      senderRefund: new Decimal(raw.senderRefund),
    };
  }

  async mutualCancel(
    sender: string,
    streamId: string,
    settlementArgs?: TokenStandardCancelArgs,
  ): Promise<CancelResult> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Mutual cancel');
    }
    const raw = await this.request<RawCancelResult>(
      'POST',
      `/api/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}/mutual-cancel`,
      settlementArgs,
    );
    return {
      recipientAmount: new Decimal(raw.recipientAmount),
      senderRefund: new Decimal(raw.senderRefund),
    };
  }

  async renew(sender: string, streamId: string, params: RenewParams): Promise<string> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Renew');
    }
    return this.request(
      'POST',
      `/api/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}/renew`,
      {
        additionalAmount: params.additionalAmount.toString(),
        newEndTime: params.newEndTime.toISOString(),
        holdingCid: params.holdingCid,
        senderAccount: params.senderAccount,
      },
    );
  }

  /**
   * Finalize custody for an accepted stream request (service-only).
   * Included for admin/debug tooling in the dashboard.
   */
  async finalizeEscrow(
    sender: string,
    streamId: string,
    recipient: string,
  ): Promise<{ escrowContractId: string }> {
    return this.request(
      'POST',
      `/api/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}/finalize`,
      {
        recipient,
      },
    );
  }

  // --- Phase 3: Delegated Policies ---

  async listPolicies(): Promise<RawPolicy[]> {
    if (this.isHostedWalletSession()) {
      await this.probeHostedLedger();
      return [];
    }
    return this.request<RawPolicy[]>('GET', '/api/policies');
  }

  async revokePolicy(contractId: string): Promise<{ newContractId: string }> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Policy revoke');
    }
    return this.request('POST', `/api/policies/${encodeURIComponent(contractId)}/revoke`);
  }

  async listExecutionLogs(policyId?: string): Promise<RawExecutionLog[]> {
    if (this.isHostedWalletSession()) {
      await this.probeHostedLedger();
      return [];
    }
    const qs = policyId ? `?policyId=${encodeURIComponent(policyId)}` : '';
    return this.request<RawExecutionLog[]>('GET', `/api/execution-logs${qs}`);
  }
}

// ---------------------------------------------------------------------------
// Wire format types (Decimal as strings, Date as ISO strings)
// ---------------------------------------------------------------------------

interface RawStream {
  contractId: string;
  config: {
    streamId: string;
    sender: string;
    recipient: string;
    totalDeposited: string;
    startTime: string;
    endTime: string;
    vestingMode: RawVestingMode;
    assetType: string;
    settlementMode?: string;
    cancellable: boolean;
    instrumentRef?: RawInstrumentRef | null;
  };
  state: {
    totalWithdrawn: string;
    status: string;
    lastWithdrawTime?: string;
    renewalCount: number;
  };
  escrowRef?: {
    escrowHoldingCid: string;
    escrowAmount: string;
    escrowOperator: string;
    instrumentRef?: RawInstrumentRef;
    recipientAccount?: Record<string, unknown>;
    fundingReference?: string;
    lastSettlementReference?: string;
    senderAccountRef?: string;
    recipientAccountRef?: string;
  };
}

interface RawPendingStreamRequest {
  contractId: string;
  config: RawStream['config'];
  recipientAccount?: Record<string, unknown>;
  observers: string[];
  fundingReference?: string;
  fundingHoldingCid?: string;
  escrowOperator?: string;
}

interface RawVestingMode {
  mode: string;
  cliffTime?: string;
  stepInterval?: number;
  amountPerStep?: string;
  termDuration?: number;
}

interface RawInstrumentRef {
  depository: string;
  issuer: string;
  instrumentId: string;
  instrumentVersion: string;
}

interface RawWithdrawResult {
  amountWithdrawn: string;
  newTotalWithdrawn: string;
  newStatus: string;
}

interface RawCancelResult {
  recipientAmount: string;
  senderRefund: string;
}

export interface RawPolicy {
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

export interface RawExecutionLog {
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

// ---------------------------------------------------------------------------
// Deserialization (wire JSON → SDK types with Decimal/Date)
// ---------------------------------------------------------------------------

function deserializeStream(raw: RawStream): Stream {
  return {
    contractId: raw.contractId,
    config: deserializeConfig(raw.config),
    state: deserializeState(raw.state),
    // Include escrowRef for custody-backed streams (built inline to avoid
    // mutating a readonly property on the Stream interface)
    ...(raw.escrowRef
      ? {
          escrowRef: {
            escrowHoldingCid: raw.escrowRef.escrowHoldingCid,
            escrowAmount: raw.escrowRef.escrowAmount,
            escrowOperator: raw.escrowRef.escrowOperator,
            instrumentRef: raw.escrowRef.instrumentRef ?? {
              depository: '',
              issuer: '',
              instrumentId: '',
              instrumentVersion: '',
            },
            recipientAccount: (raw.escrowRef.recipientAccount ?? {}) as LedgerRecord,
            fundingReference: (raw.escrowRef as any).fundingReference,
            lastSettlementReference: (raw.escrowRef as any).lastSettlementReference,
            senderAccountRef: (raw.escrowRef as any).senderAccountRef,
            recipientAccountRef: (raw.escrowRef as any).recipientAccountRef,
          },
        }
      : {}),
  };
}

function deserializePendingStreamRequest(raw: RawPendingStreamRequest): PendingStreamRequest {
  return {
    contractId: raw.contractId,
    config: deserializeConfig(raw.config),
    recipientAccount: deserializeLedgerRecord(raw.recipientAccount),
    observers: raw.observers ?? [],
    settlementMode: (raw as any).settlementMode ?? SettlementMode.TokenStandardCustody,
    fundingReference: (raw as any).fundingReference,
    fundingHoldingCid: (raw as any).fundingHoldingCid,
    escrowOperator: (raw as any).escrowOperator,
  };
}

function deserializeConfig(raw: RawStream['config']): StreamConfig {
  return {
    streamId: raw.streamId,
    sender: raw.sender,
    recipient: raw.recipient,
    totalDeposited: new Decimal(raw.totalDeposited),
    startTime: new Date(raw.startTime),
    endTime: new Date(raw.endTime),
    vestingMode: deserializeVestingMode(raw.vestingMode),
    assetType: (raw.assetType as AssetType) ?? AssetType.GlobalCip56,
    settlementMode: (raw.settlementMode as SettlementMode) ?? SettlementMode.TokenStandardCustody,
    cancellable: raw.cancellable,
    instrumentRef: raw.instrumentRef ?? undefined,
  };
}

function deserializeLedgerRecord(
  raw: Record<string, unknown> | undefined,
): LedgerRecord | undefined {
  if (!raw) return undefined;
  return raw as LedgerRecord;
}

function deserializeState(raw: RawStream['state']): StreamState {
  return {
    totalWithdrawn: new Decimal(raw.totalWithdrawn),
    status: (raw.status as StreamStatus) ?? StreamStatus.Active,
    lastWithdrawTime: raw.lastWithdrawTime ? new Date(raw.lastWithdrawTime) : undefined,
    renewalCount: raw.renewalCount ?? 0,
  };
}

function deserializeVestingMode(raw: RawVestingMode): VestingModeConfig {
  switch (raw.mode) {
    case VestingMode.CliffLinear:
      return { mode: VestingMode.CliffLinear, cliffTime: new Date(raw.cliffTime!) };
    case VestingMode.Stepped:
      return {
        mode: VestingMode.Stepped,
        stepInterval: raw.stepInterval!,
        amountPerStep: new Decimal(raw.amountPerStep!),
      };
    case VestingMode.RenewableTerm:
      return { mode: VestingMode.RenewableTerm, termDuration: raw.termDuration! };
    case VestingMode.Linear:
    default:
      return { mode: VestingMode.Linear };
  }
}

// ---------------------------------------------------------------------------
// Serialization (SDK types → wire JSON with strings)
// ---------------------------------------------------------------------------

function serializeCreateParams(params: CreateStreamParams): Record<string, unknown> {
  return {
    streamId: params.streamId,
    sender: params.sender,
    recipient: params.recipient,
    totalDeposited: params.totalDeposited.toString(),
    startTime: params.startTime.toISOString(),
    endTime: params.endTime.toISOString(),
    vestingMode: serializeVestingMode(params.vestingMode),
    assetType: params.assetType,
    settlementMode: params.settlementMode,
    instrumentRef: params.instrumentRef ?? undefined,
    holdingCid: params.holdingCid,
    fundingReference: params.fundingReference,
    escrowOperator: params.escrowOperator,
    senderAccount: params.senderAccount,
    recipientAccount: params.recipientAccount,
    cancellable: params.cancellable,
  };
}

function serializeVestingMode(config: VestingModeConfig): Record<string, unknown> {
  switch (config.mode) {
    case VestingMode.CliffLinear:
      return { mode: config.mode, cliffTime: config.cliffTime.toISOString() };
    case VestingMode.Stepped:
      return {
        mode: config.mode,
        stepInterval: config.stepInterval,
        amountPerStep: config.amountPerStep.toString(),
      };
    case VestingMode.RenewableTerm:
      return { mode: config.mode, termDuration: config.termDuration };
    case VestingMode.Linear:
    default:
      return { mode: VestingMode.Linear };
  }
}
