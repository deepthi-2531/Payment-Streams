/**
 * REST API client for the Canton Streams proxy.
 *
 * Replaces direct SDK usage (which requires Node.js) with fetch-based
 * calls to the proxy server. All Decimal values are serialized as
 * strings over the wire and reconstructed on the client side.
 *
 * Hosted wallets read AND write through their own CIP-103 `ledgerApi`
 * surface instead of the REST proxy: ACS queries via `/v2/state/acs`,
 * command submission via `/v2/commands/submit-and-wait` (the wallet
 * drives the user's signing UI). Single-party choices (create, accept,
 * withdraw, cancel, renew, policy revoke) are wired; choices that need
 * more than the connected party's signature (mutual cancel) are not.
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
import { VestingMode, StreamStatus, AssetType, SettlementMode, getBalances } from '@canton-streams/sdk/browser';
import { walletClient } from '../store/wallet/index.js';
import {
  HOSTED_TID_CREATE_REQUEST,
  HOSTED_TID_POLICY,
  HOSTED_TID_STREAM_ESCROW,
  decodeCreateStreamRequest,
  decodeStreamEscrow,
  isHostedLedgerAvailable,
  queryActiveContracts,
  submitAndWait,
} from '../lib/hostedWalletLedger.js';

/**
 * Error thrown when a mutation is attempted from a hosted-wallet
 * session that has no path to drive the underlying transaction
 * (e.g. choices needing signatures beyond the connected party).
 * Surfaced to the user via the mutation handler.
 */
export class HostedWalletWriteUnsupportedError extends Error {
  constructor(action: string, reason?: string) {
    super(
      `${action} is not available from a hosted-wallet session. ` +
        (reason ??
          `This flow needs a signer beyond the connected wallet party.`),
    );
    this.name = 'HostedWalletWriteUnsupportedError';
  }
}

/** Optional settlement args for TokenStandardCustody cancel / mutual cancel. */
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
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | null,
    private readonly getParty?: () => string | null,
  ) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) {
      h['Authorization'] = `Bearer ${token}`;
    } else {
      // Hosted-wallet sessions (Loop / PartyLayer) have no JWT. The proxy's dev
      // auth mode conveys the caller identity via X-Canton-Party, which it
      // trusts for read-scoping + role checks. (Proxy routes that the wallet
      // signs itself — e.g. V1 settle — still go through Loop's own ledger API.)
      const party = this.getParty?.();
      if (party) h['X-Canton-Party'] = party;
    }
    // When this dashboard is served through an ngrok tunnel for a live demo,
    // the ngrok-free interstitial otherwise intercepts /api XHR. The skip
    // header bypasses it; only sent when actually on an ngrok host, so it's a
    // no-op for normal deployments.
    if (
      typeof window !== 'undefined' &&
      /\.ngrok(-free)?\.(app|dev|io)$/.test(window.location.hostname)
    ) {
      h['ngrok-skip-browser-warning'] = 'true';
    }
    return h;
  }

  /**
   * True when the active session is a hosted multi-wallet (Loop /
   * Cantor8 / Send / Bron) with no JWT bearer token. Reads in this
   * mode go through `walletClient.ledgerApi` rather than the proxy.
   */
  private isHostedWalletSession(): boolean {
    if (this.getToken()) return false;
    if (!isHostedLedgerAvailable()) return false;
    return true;
  }

  /**
   * Catch the wallet's "I called the participant and it didn't
   * find the template" error and convert it to an empty result.
   * Most hosted-wallet networks (5N Loop on devnet) don't have the
   * canton-streams DAR vetted, so the legitimate response to a
   * filtered ACS query is "template not found". Returning [] in
   * that case keeps the dashboard in its honest empty state
   * instead of surfacing a wall-of-text Loop error that mentions
   * a templateId the user can't act on.
   *
   * All other errors are re-thrown so transport failures
   * (unauthorized, network down, wallet disconnected) still
   * propagate to the page.
   */
  private isDarNotDeployedError(err: unknown): boolean {
    // Errors arrive in three shapes from the wallet layer:
    //   1. An `Error` instance — `err.message` carries the text
    //      (`Failed to get active contracts ... templateId="..."`).
    //   2. A plain object thrown verbatim from the wallet's
    //      `ledgerApi` — Canton participants surface this as
    //      `{ code: "PACKAGE_NAMES_NOT_FOUND", cause: "...", ... }`
    //      and Loop forwards the JSON unchanged. The user hit this
    //      live on submit; before this change my regex was checking
    //      only `err.message` (undefined here) and let it fall
    //      through as the raw JSON.
    //   3. A string already (rare; defensive).
    // Coalesce all three into one searchable text blob before
    // running the pattern check.
    const text = (() => {
      if (err instanceof Error) return err.message;
      if (typeof err === 'string') return err;
      if (err && typeof err === 'object') {
        const e = err as { code?: unknown; cause?: unknown; message?: unknown };
        const parts: string[] = [];
        if (typeof e.code === 'string') parts.push(e.code);
        if (typeof e.message === 'string') parts.push(e.message);
        if (typeof e.cause === 'string') parts.push(e.cause);
        if (parts.length > 0) return parts.join(' ');
        try {
          return JSON.stringify(err);
        } catch {
          return String(err);
        }
      }
      return String(err);
    })();
    return /PACKAGE_NAMES_NOT_FOUND|package.*not.*found|do not match upgradable packages|Failed to get active contracts|template.*not.*found|not.*deployed|no.*package/i.test(
      text,
    );
  }

  private async readHostedParty(): Promise<string> {
    const accounts = await walletClient.listAccounts();
    const party =
      accounts.find((a) => a.primary)?.partyId ?? accounts[0]?.partyId;
    if (!party) {
      throw new Error(
        'Wallet session has no party id — try disconnecting and reconnecting the wallet.',
      );
    }
    return party;
  }

  // (The earlier `probeHostedLedger` helper was dropped — reads now
  // run the real ACS query via `queryActiveContracts` against the
  // wallet's `ledgerApi`. The probe path is documented in the
  // module's top JSDoc and in lib/hostedWalletLedger.ts.)

  /**
   * Resolve the active StreamEscrow for (sender, streamId) from the
   * wallet-visible ACS. The proxy keys streams the same way; hosted
   * sessions re-derive the contract id per write because exercised
   * choices archive-and-recreate the escrow.
   */
  private async findHostedEscrow(
    party: string,
    sender: string,
    streamId: string,
  ): Promise<{ contractId: string; stream: Stream }> {
    const entries = await queryActiveContracts([HOSTED_TID_STREAM_ESCROW], party);
    for (const e of entries) {
      const stream = decodeStreamEscrow(e.contractId, e.createArguments);
      if (stream && stream.config.sender === sender && stream.config.streamId === streamId) {
        return { contractId: e.contractId, stream };
      }
    }
    throw new Error(
      `Stream "${streamId}" from ${sender} is not visible to the connected wallet party.`,
    );
  }

  /** Resolve a pending CreateStreamRequest contract id by (sender, streamId). */
  private async findHostedCreateRequest(
    party: string,
    sender: string,
    streamId: string,
  ): Promise<string> {
    const entries = await queryActiveContracts([HOSTED_TID_CREATE_REQUEST], party);
    for (const e of entries) {
      const req = decodeCreateStreamRequest(e.contractId, e.templateId, e.createArguments);
      if (req && req.config.sender === sender && req.config.streamId === streamId) {
        return e.contractId;
      }
    }
    throw new Error(
      `No pending request for stream "${streamId}" from ${sender} is visible to the connected wallet party.`,
    );
  }

  /**
   * Exercise a choice on a streams contract via the wallet's
   * submit-and-wait endpoint. Returns the updateId when the wallet
   * surfaces one (hosted wallets do not return exercise results).
   */
  private async hostedExercise(
    templateId: string,
    contractId: string,
    choice: string,
    choiceArgument: Record<string, unknown>,
    party: string,
  ): Promise<string> {
    const result = (await submitAndWait(
      [
        {
          ExerciseCommand: {
            templateId,
            contractId,
            choice,
            choiceArgument,
          },
        },
      ],
      party,
    )) as { updateId?: string; transactionId?: string; commandId?: string } | null;
    return (
      result?.updateId ?? result?.transactionId ?? result?.commandId ?? '<submitted-via-wallet>'
    );
  }

  /** Daml Time wire value (microseconds since epoch, string-encoded). */
  private hostedTime(date: Date): string {
    return String(BigInt(date.getTime()) * 1000n);
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
      const party = await this.readHostedParty();
      try {
        const entries = await queryActiveContracts([HOSTED_TID_STREAM_ESCROW], party);
        const streams = entries
          .map((e) => decodeStreamEscrow(e.contractId, e.createArguments))
          .filter((s): s is Stream => s !== null);
        // Apply the same client-side filters the proxy would have
        // applied server-side, so call-sites see consistent
        // behavior whether we routed through the proxy or the
        // wallet's ledgerApi.
        return streams.filter((s) => {
          if (filter?.sender && s.config.sender !== filter.sender) return false;
          if (filter?.recipient && s.config.recipient !== filter.recipient) return false;
          if (filter?.status && s.state.status !== filter.status) return false;
          if (filter?.vestingMode && s.config.vestingMode.mode !== filter.vestingMode)
            return false;
          return true;
        });
      } catch (err) {
        if (this.isDarNotDeployedError(err)) return [];
        throw err;
      }
    }
    const params = new URLSearchParams();
    if (filter?.sender) params.set('sender', filter.sender);
    if (filter?.recipient) params.set('recipient', filter.recipient);
    if (filter?.status) params.set('status', filter.status);
    if (filter?.vestingMode) params.set('vestingMode', filter.vestingMode);
    const qs = params.toString();
    try {
      const raw = await this.request<RawStream[]>('GET', `/api/streams${qs ? `?${qs}` : ''}`);
      return raw.map(deserializeStream);
    } catch (err) {
      // Non-wallet (dev-mode / hosted-party) sessions read V2 streams through the
      // proxy's gRPC client, which isn't wired on every deployment (e.g. its proto
      // files are absent → the proxy returns a sanitized 500). V2 is not the V1
      // lane the demo runs on, and such a party has no V2 streams here, so degrade
      // to an empty list rather than blocking the whole app — the V1 lane has its
      // own REST path and loads fine.
      if (this.isDarNotDeployedError(err) || this.isProxyInternalError(err)) return [];
      throw err;
    }
  }

  /** True when the proxy returned its sanitized server-side failure (e.g. the
   * V2 gRPC client is not available on this deployment). Distinct from 4xx
   * business errors, which carry specific reasons. */
  private isProxyInternalError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return /internal error|HTTP 5\d\d|no such file or directory|\.proto/i.test(msg);
  }

  async listPendingStreamRequests(
    filter?: PendingStreamRequestFilter,
  ): Promise<PendingStreamRequest[]> {
    if (this.isHostedWalletSession()) {
      const party = await this.readHostedParty();
      try {
        // Only the numeric CreateStreamRequest template exists in the
        // current DAR (the per-mode token-standard request module was
        // folded into Workflow.UnifiedStream); querying a removed
        // template would fail the whole ACS read.
        const entries = await queryActiveContracts(
          [HOSTED_TID_CREATE_REQUEST],
          party,
        );
        const pending = entries
          .map((e) =>
            decodeCreateStreamRequest(e.contractId, e.templateId, e.createArguments),
          )
          .filter((r): r is PendingStreamRequest => r !== null);
        return pending.filter((r) => {
          if (filter?.sender && r.config.sender !== filter.sender) return false;
          if (filter?.recipient && r.config.recipient !== filter.recipient) return false;
          if (filter?.assetType && r.config.assetType !== filter.assetType) return false;
          return true;
        });
      } catch (err) {
        if (this.isDarNotDeployedError(err)) return [];
        throw err;
      }
    }
    const params = new URLSearchParams();
    if (filter?.sender) params.set('sender', filter.sender);
    if (filter?.recipient) params.set('recipient', filter.recipient);
    if (filter?.assetType) params.set('assetType', filter.assetType);
    const qs = params.toString();
    try {
      const raw = await this.request<RawPendingStreamRequest[]>(
        'GET',
        `/api/stream-requests${qs ? `?${qs}` : ''}`,
      );
      return raw.map(deserializePendingStreamRequest);
    } catch (err) {
      // Same rationale as listStreams: the V2 read goes through the proxy gRPC
      // client which isn't wired here for dev-mode sessions — degrade to empty.
      if (this.isDarNotDeployedError(err) || this.isProxyInternalError(err)) return [];
      throw err;
    }
  }

  async getStream(sender: string, streamId: string): Promise<Stream> {
    if (this.isHostedWalletSession()) {
      const party = await this.readHostedParty();
      const { stream } = await this.findHostedEscrow(party, sender, streamId);
      return stream;
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
    try {
      return await this.request<StreamEvent[]>(
        'GET',
        `/api/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}/history`,
      );
    } catch (err) {
      if (this.isDarNotDeployedError(err) || this.isProxyInternalError(err)) return [];
      throw err;
    }
  }

  // --- Mutations ---

  async createStream(
    params: CreateStreamParams,
  ): Promise<{ requestContractId: string; streamId: string }> {
    if (this.isHostedWalletSession()) {
      const party = await this.readHostedParty();
      // Fail fast: a custodial wallet's WRITE path (submit-and-wait) can hang
      // forever without settling when the participant lacks our DAR, so the
      // create spins indefinitely. A READ reliably rejects with
      // PACKAGE_NAMES_NOT_FOUND — probe first and surface an actionable error
      // steering to direct delivery instead of hanging.
      try {
        await queryActiveContracts([HOSTED_TID_CREATE_REQUEST], party);
      } catch (probeErr) {
        if (this.isDarNotDeployedError(probeErr)) {
          throw new Error(
            "This wallet's participant does not have the Canton Streams app deployed, " +
              'so custody streams cannot be created here. Use Direct delivery instead — ' +
              'it sends a token-standard transfer from your wallet each cycle and needs ' +
              'no streams DAR.',
          );
        }
        // A non-DAR read failure is not fatal to the create — fall through.
      }
      try {
        const command = {
          CreateCommand: {
            templateId: HOSTED_TID_CREATE_REQUEST,
            createArguments: this.serializeCreateRequestArgs(params, party),
          },
        };
        const result = (await submitAndWait([command], party, {
          commandId: `create-${params.streamId ?? Date.now()}`,
        })) as { transactionId?: string; commandId?: string };
        // The contract id of the freshly-created CreateStreamRequest
        // is not always returned by hosted wallets — we surface the
        // transactionId as a stand-in until we wire a transaction
        // tree parser.
        return {
          requestContractId:
            result.transactionId ?? result.commandId ?? '<created-via-wallet>',
          streamId: params.streamId ?? '',
        };
      } catch (err) {
        if (this.isDarNotDeployedError(err)) {
          throw new Error(
            'Cannot create a stream: the Canton Streams DAR is not vetted on the ' +
              'participant your wallet is attached to. Ask the operator to upload ' +
              "and vet the streams DAR, then refresh this page.",
          );
        }
        throw err;
      }
    }
    return this.request('POST', '/api/streams', serializeCreateParams(params));
  }

  /**
   * Build the Daml record arguments for `CreateStreamRequest` from
   * the dashboard's `CreateStreamParams`. The field set mirrors the
   * Daml template exactly (`config`, `depositAmount`, `observers`),
   * in JSON-wire form (microseconds for `Time`, decimals as strings,
   * variants as `{ tag, value }`). The template's `ensure` requires
   * `depositAmount == config.totalDeposited`.
   */
  private serializeCreateRequestArgs(
    params: CreateStreamParams,
    party: string,
  ): Record<string, unknown> {
    return {
      config: {
        streamId: params.streamId,
        sender: params.sender ?? party,
        recipient: params.recipient,
        totalDeposited: params.totalDeposited.toString(),
        startTime: this.hostedTime(params.startTime),
        endTime: this.hostedTime(params.endTime),
        vestingMode: this.serializeHostedVestingMode(params.vestingMode),
        assetType: params.assetType,
        instrumentRef: params.instrumentRef ?? null,
        cancellable: params.cancellable ?? false,
        settlementMode: params.settlementMode ?? SettlementMode.TokenStandardCustody,
      },
      depositAmount: params.totalDeposited.toString(),
      observers: [],
    };
  }

  /**
   * Encode a VestingModeConfig as the Daml variant JSON
   * (`CantonStreams.Interface.Types.VestingMode`). RelTime fields
   * are `{ microseconds }` records; the SDK config carries them as
   * microsecond numbers already.
   */
  private serializeHostedVestingMode(
    config: VestingModeConfig,
  ): Record<string, unknown> {
    switch (config.mode) {
      case VestingMode.CliffLinear:
        return {
          tag: 'CliffLinear',
          value: { cliffTime: this.hostedTime(config.cliffTime) },
        };
      case VestingMode.Stepped:
        return {
          tag: 'Stepped',
          value: {
            stepInterval: { microseconds: String(config.stepInterval) },
            amountPerStep: config.amountPerStep.toString(),
          },
        };
      case VestingMode.RenewableTerm:
        return {
          tag: 'RenewableTerm',
          value: { termDuration: { microseconds: String(config.termDuration) } },
        };
      case VestingMode.Linear:
      default:
        return { tag: 'Linear', value: {} };
    }
  }

  async acceptStream(sender: string, streamId: string): Promise<{ escrowContractId: string }> {
    if (this.isHostedWalletSession()) {
      // Resolve the pending request from the wallet-visible ACS and
      // exercise AcceptStream (controller: recipient = wallet party).
      const party = await this.readHostedParty();
      const requestCid = await this.findHostedCreateRequest(party, sender, streamId);
      const updateId = await this.hostedExercise(
        HOSTED_TID_CREATE_REQUEST,
        requestCid,
        'AcceptStream',
        {},
        party,
      );
      // Hosted wallets don't return the created contract id; the
      // updateId stands in until callers need the real escrow cid
      // (the post-mutation refetch re-reads the ACS anyway).
      return { escrowContractId: updateId };
    }
    return this.request(
      'POST',
      `/api/streams/${encodeURIComponent(sender)}/${encodeURIComponent(streamId)}/accept`,
    );
  }

  async withdraw(sender: string, streamId: string): Promise<WithdrawResult> {
    if (this.isHostedWalletSession()) {
      const party = await this.readHostedParty();
      const { contractId, stream } = await this.findHostedEscrow(party, sender, streamId);
      const now = new Date();
      await this.hostedExercise(
        HOSTED_TID_STREAM_ESCROW,
        contractId,
        'Withdraw_Stream',
        { withdrawTime: this.hostedTime(now) },
        party,
      );
      // submit-and-wait via the wallet doesn't return exercise
      // results — report the client-side accrual estimate; the
      // ledger remains authoritative and the refetch shows the
      // updated state.
      const balances = getBalances(stream, now);
      const newTotal = stream.state.totalWithdrawn.plus(balances.withdrawable);
      return {
        amountWithdrawn: balances.withdrawable,
        newTotalWithdrawn: newTotal,
        newStatus: newTotal.greaterThanOrEqualTo(stream.config.totalDeposited)
          ? StreamStatus.Completed
          : StreamStatus.Active,
      };
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
   * Cancel a stream.
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
      const party = await this.readHostedParty();
      const { contractId, stream } = await this.findHostedEscrow(party, sender, streamId);
      const now = new Date();
      await this.hostedExercise(
        HOSTED_TID_STREAM_ESCROW,
        contractId,
        'Cancel_Stream',
        { cancelTime: this.hostedTime(now) },
        party,
      );
      // Client-side estimate; the ledger computes the real split.
      const balances = getBalances(stream, now);
      return {
        recipientAmount: balances.withdrawable,
        senderRefund: balances.refundable,
      };
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
      // MutualCancel_Stream is controlled by sender AND recipient; a
      // hosted wallet session only acts as the connected party, so it
      // cannot authorize the joint exercise. Route via an operator
      // (proxy) or use the unilateral cancel when cancellable.
      throw new HostedWalletWriteUnsupportedError(
        'Mutual cancel',
        'The choice needs both sender and recipient signatures; the connected wallet only signs for one party.',
      );
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
      const party = await this.readHostedParty();
      const { contractId } = await this.findHostedEscrow(party, sender, streamId);
      const now = new Date();
      return this.hostedExercise(
        HOSTED_TID_STREAM_ESCROW,
        contractId,
        'Renew_Stream',
        {
          additionalDeposit: params.additionalAmount.toString(),
          newEndTime: this.hostedTime(params.newEndTime),
          renewTime: this.hostedTime(now),
        },
        party,
      );
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

  // --- Delegated Policies ---

  async listPolicies(): Promise<RawPolicy[]> {
    if (this.isHostedWalletSession()) {
      const party = await this.readHostedParty();
      try {
        const entries = await queryActiveContracts([HOSTED_TID_POLICY], party);
        // We don't have a browser-side `DelegatedPolicy` decoder
        // yet; surface the raw create_arguments as a typed shape
        // the PoliciesPage can render. If the DAR isn't deployed
        // this returns [] via the catch below.
        return entries.map((e) => ({
          contractId: e.contractId,
          ...e.createArguments,
        })) as unknown as RawPolicy[];
      } catch (err) {
        if (this.isDarNotDeployedError(err)) return [];
        throw err;
      }
    }
    try {
      return await this.request<RawPolicy[]>('GET', '/api/policies');
    } catch (err) {
      if (this.isDarNotDeployedError(err) || this.isProxyInternalError(err)) return [];
      throw err;
    }
  }

  async revokePolicy(contractId: string): Promise<{ newContractId: string }> {
    if (this.isHostedWalletSession()) {
      // RevokePolicy is sender-controlled and the cid is in hand.
      const party = await this.readHostedParty();
      const updateId = await this.hostedExercise(
        HOSTED_TID_POLICY,
        contractId,
        'RevokePolicy',
        {},
        party,
      );
      return { newContractId: updateId };
    }
    return this.request('POST', `/api/policies/${encodeURIComponent(contractId)}/revoke`);
  }

  async listExecutionLogs(policyId?: string): Promise<RawExecutionLog[]> {
    if (this.isHostedWalletSession()) {
      // ExecutionLog is a non-consumed contract on the policy; the
      // browser doesn't have a decoder for it yet. Return [] until
      // the read path lands as part of the full DelegatedPolicy
      // browser flow.
      return [];
    }
    const qs = policyId ? `?policyId=${encodeURIComponent(policyId)}` : '';
    try {
      return await this.request<RawExecutionLog[]>('GET', `/api/execution-logs${qs}`);
    } catch (err) {
      if (this.isDarNotDeployedError(err) || this.isProxyInternalError(err)) return [];
      throw err;
    }
  }

  // --- Open-ended Flows (StreamFlow, non-prefunded / rolling top-up) ---

  async listFlows(filter?: { sender?: string; recipient?: string }): Promise<RawFlow[]> {
    if (this.isHostedWalletSession()) {
      // No browser-side StreamFlow decoder yet; keep the honest empty
      // state for hosted wallets (same posture as execution logs).
      return [];
    }
    const params = new URLSearchParams();
    if (filter?.sender) params.set('sender', filter.sender);
    if (filter?.recipient) params.set('recipient', filter.recipient);
    const qs = params.toString();
    try {
      return await this.request<RawFlow[]>('GET', `/api/flows${qs ? `?${qs}` : ''}`);
    } catch (err) {
      if (this.isDarNotDeployedError(err) || this.isProxyInternalError(err)) return [];
      throw err;
    }
  }

  async createFlow(params: CreateFlowRequest): Promise<{ contractId: string; streamId: string }> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Create flow');
    }
    return this.request('POST', '/api/flows', params);
  }

  /**
   * Supported assets for the create-stream / create-flow asset picker. Public
   * deployment config — admin parties resolved server-side for this network.
   * Returns `[]` on any error so the picker degrades to Custom-only.
   */
  async listAssets(): Promise<SupportedAsset[]> {
    try {
      return await this.request<SupportedAsset[]>('GET', '/api/assets');
    } catch {
      return [];
    }
  }

  async topUpFlow(
    sender: string,
    flowId: string,
    args: { topUpAmount: string; settlementReference: string },
  ): Promise<{ newFlowCid: string }> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Flow top-up');
    }
    return this.request(
      'POST',
      `/api/flows/${encodeURIComponent(sender)}/${encodeURIComponent(flowId)}/top-up`,
      args,
    );
  }

  async withdrawFlow(
    sender: string,
    flowId: string,
    args: { settlementReference: string },
  ): Promise<{ newFlowCid: string }> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Flow withdraw');
    }
    return this.request(
      'POST',
      `/api/flows/${encodeURIComponent(sender)}/${encodeURIComponent(flowId)}/withdraw`,
      args,
    );
  }

  async stopFlow(
    sender: string,
    flowId: string,
    args: {
      recipientSettlement: string;
      senderRefund: string;
      recipientSettlementReference?: string;
      senderRefundReference?: string;
    },
  ): Promise<{ newFlowCid: string }> {
    if (this.isHostedWalletSession()) {
      throw new HostedWalletWriteUnsupportedError('Flow stop');
    }
    return this.request(
      'POST',
      `/api/flows/${encodeURIComponent(sender)}/${encodeURIComponent(flowId)}/stop`,
      args,
    );
  }

  // --- V1 streams (proxy /api/v1/streams group) ---
  //
  // The V1 lane supports two token-standard paths. Direct delivery draws each
  // cycle from the payer wallet via TransferFactory_Transfer. Receiver-claim
  // first creates a funded V1 Allocation plus ReceiverClaimV1, then lets the
  // recipient claim after unlockAt. Receiver-claim requires the V1 shim DAR on
  // the participant creating ReceiverClaimV1; public hosted-wallet demos should
  // use direct delivery.

  async createStreamV1(params: V1CreateStreamParams): Promise<V1StreamView> {
    return this.request<V1StreamView>('POST', '/api/v1/streams', params);
  }

  async listStreamsV1(): Promise<V1StreamView[]> {
    return this.request<V1StreamView[]>('GET', '/api/v1/streams');
  }

  async getStreamV1(id: string): Promise<V1StreamView> {
    return this.request<V1StreamView>('GET', `/api/v1/streams/${encodeURIComponent(id)}`);
  }

  async settleStreamV1(id: string, body?: V1SettleParams): Promise<V1SettleResult> {
    return this.request<V1SettleResult>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/settle`,
      body ?? {},
    );
  }

  /** Stop a V1 stream (payer only) — halts accrual + settlement. */
  async stopStreamV1(id: string): Promise<V1StreamView> {
    return this.request<V1StreamView>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/stop`,
      {},
    );
  }

  // --- Operator-custodied escrow ---

  /** The escrow party + instrument a wallet needs to fund an escrow deposit. */
  async escrowInfo(): Promise<EscrowInfo> {
    return this.request<EscrowInfo>('GET', '/api/v1/escrow-info');
  }

  /** Form the payer→escrow deposit for the payer's wallet to sign (model 2). */
  async prepareEscrowDeposit(body: {
    payerParty?: string;
    totalDeposit: string;
    holdings?: { cid: string; amount: number }[];
  }): Promise<EscrowPreparedDeposit> {
    return this.request<EscrowPreparedDeposit>('POST', '/api/v1/escrows/prepare-deposit', body);
  }

  /** Create an escrow: deposit (proxy or wallet-signed) + start streaming. */
  async createEscrow(params: CreateEscrowParams): Promise<EscrowView> {
    return this.request<EscrowView>('POST', '/api/v1/escrows', params);
  }

  async listEscrows(): Promise<EscrowView[]> {
    return this.request<EscrowView[]>('GET', '/api/v1/escrows');
  }

  async getEscrow(id: string): Promise<EscrowView> {
    return this.request<EscrowView>('GET', `/api/v1/escrows/${encodeURIComponent(id)}`);
  }

  /** Refund the unspent balance to the payer and close the escrow (payer only). */
  async refundEscrow(id: string): Promise<EscrowView> {
    return this.request<EscrowView>('POST', `/api/v1/escrows/${encodeURIComponent(id)}/refund`, {});
  }

  /** Reconcile the audit trail against the chain (OperatorEscrow + balances + offers). */
  async reconcileEscrow(id: string): Promise<EscrowReconciliation> {
    return this.request<EscrowReconciliation>('GET', `/api/v1/escrows/${encodeURIComponent(id)}/reconcile`);
  }

  /** Model 2 phase 1: form (no submit) the next cycle's transfer so the payer's
   * wallet can submit it through its own participant. */
  async prepareSettleV1(id: string, body: V1PrepareSettleParams): Promise<V1PreparedSettle> {
    return this.request<V1PreparedSettle>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/prepare-settle`,
      body,
    );
  }

  /** Self-heal: record any offer that committed on-ledger but whose record was
   * lost (e.g. the wallet threw a false rejection after the transfer landed). */
  async recoverPendingV1(id: string): Promise<{ recovered: V1PendingTransferRecord[] }> {
    return this.request<{ recovered: V1PendingTransferRecord[] }>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/recover-pending`,
      {},
    );
  }

  /** Model 2 phase 2: record a cycle the wallet already committed on-ledger. */
  async recordSettleV1(id: string, body: V1RecordSettleParams): Promise<V1SettleResult> {
    return this.request<V1SettleResult>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/record-settle`,
      body,
    );
  }

  /** Receiver-claim phase 1: form Alice's AllocationFactory_Allocate command. */
  async prepareAllocationV1(
    id: string,
    body: V1PrepareAllocationParams,
  ): Promise<V1PreparedAllocation> {
    return this.request<V1PreparedAllocation>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/prepare-allocation`,
      body,
    );
  }

  /** Receiver-claim phase 2: record the allocation cid Alice's wallet created. */
  async recordAllocationV1(id: string, body: V1RecordAllocationParams): Promise<V1ReceiverClaimRecord> {
    return this.request<V1ReceiverClaimRecord>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/record-allocation`,
      body,
    );
  }

  /** Receiver-claim phase 3: form Alice's ReceiverClaimV1 create command. */
  async prepareReceiverClaimV1(
    id: string,
    body: V1PrepareReceiverClaimParams,
  ): Promise<V1PreparedReceiverClaim> {
    return this.request<V1PreparedReceiverClaim>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/prepare-receiver-claim`,
      body,
    );
  }

  /** Receiver-claim phase 4: record the ReceiverClaimV1 cid Alice created. */
  async recordReceiverClaimV1(id: string, body: V1RecordReceiverClaimParams): Promise<V1ReceiverClaimRecord> {
    return this.request<V1ReceiverClaimRecord>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/record-receiver-claim`,
      body,
    );
  }

  /** Receiver-claim phase 5: form Bob's Claim command with registry context. */
  async prepareClaimV1(id: string, body: V1PrepareClaimParams): Promise<V1PreparedClaim> {
    return this.request<V1PreparedClaim>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/prepare-claim`,
      body,
    );
  }

  /** Receiver-claim phase 6: record Bob's wallet-submitted claim. */
  async recordClaimV1(id: string, body: V1RecordClaimParams): Promise<V1SettleResult> {
    return this.request<V1SettleResult>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/record-claim`,
      body,
    );
  }

  // --- Pending-offer lane (TransferInstruction Accept / Withdraw) ---
  //
  // recordSettleV1 already classifies the on-chain outcome: when a settle lands
  // as a pending offer it returns `{ settled: false, pending }`. The recipient
  // then accepts via prepare/record-accept; the sender retries via withdraw.

  /** Recipient: form the TransferInstruction_Accept command for a pending offer. */
  async prepareAcceptTransferV1(
    id: string,
    body: V1PendingSelector,
  ): Promise<V1PreparedInstructionAction> {
    return this.request<V1PreparedInstructionAction>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/prepare-accept`,
      body,
    );
  }

  /** Recipient: record the accepted transfer once the wallet committed it. */
  async recordAcceptTransferV1(
    id: string,
    body: V1RecordInstructionParams,
  ): Promise<V1SettleResult> {
    return this.request<V1SettleResult>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/record-accept`,
      body,
    );
  }

  /** Recipient (hosted / dev-mode, no browser wallet): the proxy forms, submits
   * AND records the accept on behalf of a recipient hosted on its participant. */
  async acceptTransferV1(id: string, body: V1PendingSelector): Promise<V1SettleResult> {
    return this.request<V1SettleResult>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/accept`,
      body,
    );
  }

  /** Sender: form the TransferInstruction_Withdraw command to reclaim an offer. */
  async prepareWithdrawTransferV1(
    id: string,
    body: V1PendingSelector,
  ): Promise<V1PreparedInstructionAction> {
    return this.request<V1PreparedInstructionAction>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/prepare-withdraw`,
      body,
    );
  }

  /** Sender: record the withdrawal once the wallet committed it. */
  async recordWithdrawTransferV1(
    id: string,
    body: V1RecordInstructionParams,
  ): Promise<V1WithdrawResult> {
    return this.request<V1WithdrawResult>(
      'POST',
      `/api/v1/streams/${encodeURIComponent(id)}/record-withdraw`,
      body,
    );
  }

  /** Ledger-backed incoming view for the connected party: pending offers +
   * delivered CC, read straight from the participant. Unlike listStreamsV1
   * (proxy JSON store), this surfaces EVERY transfer to the party — including
   * raw-registry and wallet-sent ones the proxy never tracked. */
  async listReceivedV1(): Promise<V1ReceivedView> {
    return this.request<V1ReceivedView>('GET', '/api/v1/received');
  }

  /** Recipient (hosted / dev-mode): accept a pending incoming offer by contract
   * id. The proxy submits TransferInstruction_Accept as the connected party. */
  async acceptReceivedV1(transferInstructionCid: string): Promise<V1ReceivedAcceptResult> {
    return this.request<V1ReceivedAcceptResult>('POST', '/api/v1/received/accept', {
      transferInstructionCid,
    });
  }

  /** Recipient (wallet party NOT hosted on the proxy's participant, e.g. a Loop
   * party): build the TransferInstruction_Accept command + disclosures so the
   * caller's own wallet can sign and submit it. */
  async prepareAcceptReceivedV1(transferInstructionCid: string): Promise<V1ReceivedPreparedAccept> {
    return this.request<V1ReceivedPreparedAccept>('POST', '/api/v1/received/prepare-accept', {
      transferInstructionCid,
    });
  }
}

// ---------------------------------------------------------------------------
// V1 wire types (proxy /api/v1/streams — V1StreamView et al.)
//
// Mirrors the proxy V1 API contract. All decimals are strings on the wire
// and stay strings in the UI (the V1 views are display-only — we never do
// Decimal math on them client-side, so no reconstruction is needed).
// ---------------------------------------------------------------------------

export type V1Cadence = 'second' | 'minute' | 'hourly' | 'daily';
export type V1ArrearsPolicy = 'catch-up' | 'skip-missed';

export interface V1CreateStreamParams {
  readonly streamId?: string;
  readonly appId?: string;
  /** REQUIRED on-chain payer; must equal the caller party. */
  readonly payerParty: string;
  /** REQUIRED recipient; must hold a TransferPreapproval. */
  readonly recipientParty: string;
  /** REQUIRED decimal-as-string accrued per cadence period. */
  readonly ratePerCycle: string;
  readonly cadence?: V1Cadence;
  readonly effectiveFrom?: string;
  readonly termEnd?: string;
  readonly arrearsPolicy?: V1ArrearsPolicy;
  readonly totalDeposited?: string;
  readonly createAdminRecord?: boolean;
  readonly cancellable?: boolean;
  readonly observers?: readonly string[];
}

export interface V1Agreement {
  readonly agreementId: string;
  readonly appId?: string;
  readonly payerParty: string;
  readonly recipientParty: string;
  readonly ratePerPeriod: string;
  readonly cadence: V1Cadence;
  readonly effectiveFrom: string;
  readonly termEnd?: string;
  readonly arrearsPolicy: V1ArrearsPolicy;
  readonly streamAdminCid?: string;
  readonly totalDeposited: string;
  readonly createdAt: string;
  /** Lifecycle: 'stopped' means the stream was halted (no more accrual/settle). */
  readonly status?: 'active' | 'stopped';
}

export interface V1HistoryEntry {
  readonly at: string;
  readonly amount: string;
  readonly ref: string;
  readonly updateId: string;
}

export type V1ReceiverClaimStatus = 'allocated' | 'claim_ready' | 'claimed' | 'withdrawn';

export interface V1ReceiverClaimRecord {
  readonly cycle: number;
  readonly amount: string;
  readonly ref: string;
  readonly executor: string;
  readonly allocationCid: string;
  readonly receiverClaimCid?: string;
  readonly allocationUpdateId?: string;
  readonly claimUpdateId?: string;
  readonly unlockAt: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly status: V1ReceiverClaimStatus;
}

export type V1PendingTransferStatus = 'pending' | 'accepted' | 'withdrawn';

/** A pending transfer offer — a cycle whose transfer landed as a
 * TransferInstruction (recipient had no pre-approval) and awaits the
 * recipient's acceptance. Money moves only when `status` becomes `accepted`. */
export interface V1PendingTransferRecord {
  readonly cycle: number;
  readonly amount: string;
  readonly ref: string;
  readonly transferInstructionCid: string;
  readonly createUpdateId?: string;
  readonly finalUpdateId?: string;
  readonly executeBefore: string;
  readonly createdAt: string;
  readonly status: V1PendingTransferStatus;
}

export interface V1State {
  readonly settled: number;
  readonly cycles: number;
  readonly history: readonly V1HistoryEntry[];
  readonly receiverClaims?: readonly V1ReceiverClaimRecord[];
  readonly pendingTransfers?: readonly V1PendingTransferRecord[];
}

export interface V1OnLedger {
  readonly contractId: string;
  readonly totalWithdrawn: string;
  readonly numIterations: number;
  readonly status: string;
  readonly currentAllocationCid: string;
}

export interface V1StreamView {
  readonly agreement: V1Agreement;
  readonly state: V1State;
  /** Decimal(10) accrued to now. */
  readonly accrued: string;
  /** Decimal(10) due this cycle per arrears policy. */
  readonly due: string;
  /** Best-effort on-ledger StreamAdmin projection (detail route only). */
  readonly onLedger?: V1OnLedger;
}

export interface V1SettleParams {
  readonly force?: boolean;
  readonly amount?: string;
}

// --- Operator-custodied escrow (proxy /api/v1/escrows group) ---

export type EscrowStatus = 'active' | 'completed' | 'refunded';

export interface EscrowReleaseRecord {
  readonly at: string;
  readonly amount: string;
  readonly updateId: string;
  /** Set when the cycle landed as a pending offer (payee has no preapproval). */
  readonly pending?: boolean;
}

/** One operator-custodied stream: the payer deposited `totalDeposited` into the
 * operator-controlled escrow party once, and the operator streams `ratePerCycle`
 * to the payee every `cadenceSeconds` until the deposit is exhausted. */
// --- Audit / flow ledger ---

export type EscrowLegKind = 'deposit' | 'release' | 'refund';
export type EscrowLegDirection = 'in' | 'out';
export type EscrowDelivery = 'direct' | 'pending_offer';
export type EscrowOfferStatus = 'active' | 'accepted' | 'withdrawn' | 'expired';
export type EscrowInitiator = 'payer' | 'streamer' | 'operator';

/** One append-only leg of value moving through the escrow — the audit row. */
export interface EscrowLedgerEntry {
  readonly seq: number;
  readonly eventId: string;
  readonly kind: EscrowLegKind;
  readonly direction: EscrowLegDirection;
  readonly from: string;
  readonly to: string;
  readonly custodian: string;
  readonly amount: string;
  readonly instrumentAdmin: string;
  readonly instrumentId: string;
  readonly cycleNo?: number;
  readonly scheduledDueAt?: string;
  readonly updateId?: string;
  readonly contractCid?: string;
  readonly transferInstructionCid?: string;
  readonly offerExpiresAt?: string;
  readonly delivery: EscrowDelivery;
  readonly offerStatus?: EscrowOfferStatus;
  readonly acceptUpdateId?: string;
  readonly acceptedAt?: string;
  readonly initiatedBy: EscrowInitiator;
  readonly authorizationBasis?: string;
  readonly reasonCode?: string;
  readonly at: string;
  readonly recordTime?: string;
}

/** Computed roll-up — streamed / delivered / pending / refunded / remaining. */
export interface EscrowSummary {
  readonly totalIn: string;
  readonly totalStreamed: string;
  readonly totalDelivered: string;
  readonly totalPending: string;
  readonly totalRefunded: string;
  readonly totalRefundPending: string;
  readonly remaining: string;
  readonly cyclesReleased: number;
  readonly cyclesDelivered: number;
  readonly cyclesPending: number;
  readonly firstReleaseAt?: string;
  readonly lastReleaseAt?: string;
}

/** Result of reconciling the audit trail against the chain. */
export interface EscrowReconciliation {
  readonly at: string;
  readonly escrowId: string;
  readonly offLedger: {
    readonly totalStreamed: string;
    readonly totalDelivered: string;
    readonly totalPending: string;
    readonly totalRefunded: string;
    readonly remaining: string;
  };
  readonly onLedger: {
    readonly operatorEscrowCid?: string;
    readonly operatorReleased?: string;
    readonly operatorTotalDeposited?: string;
    readonly operatorStatus?: string;
    readonly escrowFreeBalance: string;
    readonly commingled: boolean;
  };
  readonly offers: ReadonlyArray<{
    readonly seq: number;
    readonly kind: EscrowLegKind;
    readonly cycleNo?: number;
    readonly transferInstructionCid: string;
    readonly amount: string;
    readonly to: string;
    readonly status: EscrowOfferStatus;
  }>;
  readonly checks: ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly detail: string }>;
}

export interface EscrowView {
  readonly escrowId: string;
  readonly originalPayer: string;
  readonly recipient: string;
  readonly ratePerCycle: string;
  readonly cadenceSeconds: number;
  readonly totalDeposited: string;
  readonly released: string;
  readonly fundingTransferId: string;
  readonly operatorEscrowCid?: string;
  readonly status: EscrowStatus;
  readonly createdAt: string;
  readonly nextDueAt: string;
  readonly lastReleaseAt?: string;
  readonly releases: readonly EscrowReleaseRecord[];
  /** Append-only audit/flow ledger. */
  readonly ledger: readonly EscrowLedgerEntry[];
  /** Computed audit roll-up. */
  readonly summary: EscrowSummary;
}

export interface EscrowInfo {
  readonly escrowParty: string;
  readonly instrumentAdmin: string;
  readonly instrumentId: string;
  readonly tickSeconds: number;
}

export interface CreateEscrowParams {
  readonly escrowId?: string;
  /** Defaults to the caller party; must equal it. */
  readonly payerParty?: string;
  readonly recipient: string;
  readonly ratePerCycle: string;
  readonly cadenceSeconds: number;
  readonly totalDeposit: string;
  /** When the payer's WALLET signed the deposit itself, its updateId. Omit to
   * have the proxy submit the deposit (hosted/dev payer only). */
  readonly fundingTransferId?: string;
}

/** A payer→escrow deposit transfer formed by the proxy for the wallet to sign. */
export interface EscrowPreparedDeposit {
  readonly ref: string;
  readonly amount: string;
  readonly executeBefore: string;
  readonly actAs: string;
  readonly command: unknown;
  readonly disclosedContracts: readonly unknown[];
}

export interface V1SettleResult {
  readonly settled: boolean;
  readonly cycle?: number;
  readonly amount?: string;
  readonly ref?: string;
  readonly updateId?: string;
  readonly adminSynced?: boolean;
  readonly reason?: string;
  /** Present when a settle landed as a pending offer (recipient has no
   * pre-approval). `settled` is false in that case — the recipient must accept. */
  readonly pending?: V1PendingTransferRecord;
}

/** A pending incoming offer (AmuletTransferInstruction) the connected party may
 * accept — read from the ledger, so not tied to any proxy stream record. */
export interface V1ReceivedPendingOffer {
  readonly transferInstructionCid: string;
  readonly amount: string;
  readonly sender: string;
  readonly instrumentId: string;
  readonly requestedAt?: string;
  readonly executeBefore?: string;
  /** True once the accept-by deadline has passed — Accept is no longer possible. */
  readonly expired: boolean;
}

/** CC already delivered to the connected party (an accepted incoming transfer). */
export interface V1ReceivedTransfer {
  readonly updateId: string;
  readonly amount: string;
  readonly at: string;
}

/** Ledger-backed incoming view returned by GET /api/v1/received. */
export interface V1ReceivedView {
  readonly party: string;
  readonly pending: readonly V1ReceivedPendingOffer[];
  readonly received: readonly V1ReceivedTransfer[];
}

export interface V1ReceivedAcceptResult {
  readonly updateId: string;
  readonly amount: string;
  readonly sender: string;
}

/** The prepared TransferInstruction_Accept for a wallet party to sign+submit. */
export interface V1ReceivedPreparedAccept {
  readonly command: unknown;
  readonly disclosedContracts: readonly unknown[];
  readonly actAs: string;
}

/** Model 2 — prepare-settle request. `holdings` are the payer's spendable
 * Amulet holdings (read from the wallet's own participant). */
export interface V1PrepareSettleParams {
  readonly force?: boolean;
  readonly amount?: string;
  readonly holdings?: ReadonlyArray<{ readonly cid: string; readonly amount: number }>;
}

/** Model 2 — the ready-to-submit transfer the wallet signs. */
export interface V1PreparedSettle {
  readonly prepared: boolean;
  readonly reason?: string;
  readonly ref?: string;
  readonly cycle?: number;
  readonly amount?: string;
  /** transfer.executeBefore — the offer expiry if it lands as a pending instruction. */
  readonly executeBefore?: string;
  readonly actAs?: string;
  readonly command?: Record<string, unknown>;
  readonly disclosedContracts?: ReadonlyArray<Record<string, unknown>>;
}

/** Model 2 — record a cycle the wallet already committed. */
export interface V1RecordSettleParams {
  readonly updateId: string;
  readonly amount: string;
  readonly ref?: string;
  /** transfer.executeBefore — passed through so a pending offer carries its expiry. */
  readonly executeBefore?: string;
}

export interface V1PrepareAllocationParams extends V1PrepareSettleParams {
  /** Optional override. Omit for hosted UX: executor defaults to recipient. */
  readonly executor?: string;
  /** On-ledger claim unlock time; defaults to the next cycle boundary. */
  readonly unlockAt?: string;
  /** Allocation settleBefore + ReceiverClaim expiry. */
  readonly expiresAt?: string;
}

export interface V1PreparedAllocation {
  readonly prepared: boolean;
  readonly reason?: string;
  readonly ref?: string;
  readonly cycle?: number;
  readonly amount?: string;
  readonly executor?: string;
  readonly unlockAt?: string;
  readonly expiresAt?: string;
  readonly actAs?: string;
  readonly command?: Record<string, unknown>;
  readonly disclosedContracts?: ReadonlyArray<Record<string, unknown>>;
}

export interface V1RecordAllocationParams {
  readonly allocationCid: string;
  readonly allocationUpdateId?: string;
  readonly amount: string;
  readonly ref?: string;
  readonly cycle: number;
  readonly executor?: string;
  readonly unlockAt: string;
  readonly expiresAt: string;
}

export interface V1PrepareReceiverClaimParams {
  readonly cycle?: number;
  readonly allocationCid?: string;
}

export interface V1PreparedReceiverClaim {
  readonly ref: string;
  readonly cycle: number;
  readonly amount: string;
  readonly allocationCid: string;
  readonly executor: string;
  readonly unlockAt: string;
  readonly expiresAt: string;
  readonly actAs: string;
  readonly command: Record<string, unknown>;
  readonly disclosedContracts: ReadonlyArray<Record<string, unknown>>;
}

export interface V1RecordReceiverClaimParams {
  readonly receiverClaimCid: string;
  readonly cycle?: number;
  readonly allocationCid?: string;
}

export interface V1PrepareClaimParams {
  readonly cycle?: number;
  readonly allocationCid?: string;
  readonly receiverClaimCid?: string;
}

export interface V1PreparedClaim {
  readonly prepared: boolean;
  readonly reason?: string;
  readonly ref?: string;
  readonly cycle?: number;
  readonly amount?: string;
  readonly allocationCid?: string;
  readonly receiverClaimCid?: string;
  readonly actAs?: string;
  readonly command?: Record<string, unknown>;
  readonly disclosedContracts?: ReadonlyArray<Record<string, unknown>>;
}

export interface V1RecordClaimParams {
  readonly updateId: string;
  readonly cycle?: number;
  readonly allocationCid?: string;
  readonly receiverClaimCid?: string;
}

// --- Pending-offer lane (TransferInstruction Accept / Withdraw) ---

/** Selector for a pending offer — by cid (preferred) or cycle. */
export interface V1PendingSelector {
  readonly transferInstructionCid?: string;
  readonly cycle?: number;
}

/** Ready-to-submit TransferInstruction_Accept / _Withdraw command. */
export interface V1PreparedInstructionAction {
  readonly prepared: boolean;
  readonly reason?: string;
  readonly ref?: string;
  readonly cycle?: number;
  readonly amount?: string;
  readonly transferInstructionCid?: string;
  readonly actAs?: string;
  readonly command?: Record<string, unknown>;
  readonly disclosedContracts?: ReadonlyArray<Record<string, unknown>>;
}

export interface V1RecordInstructionParams {
  readonly updateId: string;
  readonly transferInstructionCid?: string;
  readonly cycle?: number;
}

export interface V1WithdrawResult {
  readonly withdrawn: boolean;
  readonly reason?: string;
  readonly cycle?: number;
  readonly updateId?: string;
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

/** Wire shape of a StreamFlow contract as serialized by the proxy. */
export interface RawFlow {
  contractId: string;
  streamId: string;
  sender: string;
  recipient: string;
  escrowOperator: string;
  instrumentRef: RawInstrumentRef;
  flowRate: string;
  startTime: string;
  fundedAmount: string;
  totalWithdrawn: string;
  status: 'FlowActive' | 'FlowPaused' | 'FlowStopped';
  pausedAt?: string;
  cumulativePausedMicros: number;
  lastSettlementReference?: string;
  numIterations: number;
}

/** One supported asset returned by GET /api/assets. */
export interface SupportedAsset {
  key: string;
  displayName: string;
  instrumentAdmin: string;
  instrumentId: string;
  standard: string;
  note?: string;
}

/** Create-flow request body (POST /api/flows). */
export interface CreateFlowRequest {
  streamId?: string;
  sender?: string;
  recipient: string;
  escrowOperator?: string;
  instrumentRef: RawInstrumentRef;
  /** Tokens per microsecond, decimal string. */
  flowRate: string;
  /** Initial funded balance, decimal string (>= 0). */
  fundedAmount: string;
  /** ISO timestamp; defaults to now on the proxy. */
  startTime?: string;
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
