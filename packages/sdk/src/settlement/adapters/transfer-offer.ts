/**
 * @module settlement/adapters/transfer-offer
 *
 * TransferOfferAdapter — settlement via a hosted wallet transfer + receiver-side
 * transfer_accept flow.
 *
 * This is the generic path for DA Utility / token-standard assets whose transfer
 * lifecycle is:
 *   1. Sender asks the host wallet/app to create a token transfer
 *   2. Receiver sees a pending TransferOffer / TransferInstruction
 *   3. Receiver accepts it through a hosted interactive transfer_accept action
 *
 * Streams stays platform-agnostic by only depending on that host-wallet surface:
 *   - POST /api/wallet/transfer
 *   - GET  /api/wallet/pending-transfers
 *   - POST /api/wallet-gateway/prepare-action
 *   - POST /api/wallet-gateway/execute-action
 *
 * Any app can integrate DA Utility streaming by exposing equivalent endpoints
 * and providing per-party wallet credentials to the adapter.
 */

import type { Logger } from 'pino';
import Decimal from 'decimal.js';
import type { Transport } from '../../transport/base.js';
import type { SettlementAdapter, TransferParams, TransferResult } from '../adapter.js';
import {
  type HostedWalletPartyCredentials,
  type WalletGatewayExecuteResponse,
  extractSettlementReferenceFromWalletGatewayResult,
  readHostedWalletCredentialMapFromEnv,
  signPreparedHash,
  trimToUndefined,
} from './hosted-wallet.js';

export interface TransferOfferAdapterConfig {
  readonly baseUrl?: string;
  readonly transferPath?: string;
  readonly jsonApiUrl?: string;
  readonly ledgerToken?: string;
  readonly ledgerUserId?: string;
  readonly synchronizerId?: string;
  readonly registryApiBase?: string;
  readonly registryToken?: string;
  readonly transferFactoryPathTemplate?: string;
  readonly transferFactoryTemplate?: string;
  readonly transferExecuteBeforeSec?: number;
  readonly instrumentIds?: readonly string[];
  readonly registrarPrefixes?: readonly string[];
  readonly walletTransferTotalTimeoutMs?: number;
  readonly cip56MaxAttempts?: number;
  readonly cip56MaxCommandAttempts?: number;
  readonly cip56SubmitTimeoutMs?: number;
  readonly pendingPollAttempts?: number;
  readonly pendingPollIntervalMs?: number;
  readonly credentials?: Readonly<Record<string, HostedWalletPartyCredentials>>;
  readonly fetchImpl?: typeof fetch;
}

interface TransferOfferPartyCredentials extends HostedWalletPartyCredentials {
  readonly appToken: string;
}

interface TransferOfferSigningCredentials extends TransferOfferPartyCredentials {
  readonly publicKey: string;
  readonly privateKey?: string;
  readonly privateKeyFile?: string;
}

interface PendingTransferRecord {
  readonly contractId: string;
  readonly templateId?: string;
  readonly sender?: string;
  readonly receiver?: string;
  readonly amount?: Decimal;
  readonly instrumentId?: string;
  readonly instrumentAdmin?: string;
  readonly requestedAt?: Date;
  readonly expired: boolean;
}

interface HoldingCandidate {
  readonly contractId: string;
  readonly instrument: {
    readonly id: string;
    readonly admin?: string;
  } | null;
  readonly amount: Decimal;
}

interface InteractivePrepareResponse {
  readonly preparedTransactionHash?: string | null;
  readonly preparedTransaction?: string | null;
  readonly hashingSchemeVersion?: string | null;
  readonly deduplicationPeriod?: Record<string, unknown> | null;
}

interface NormalizedChoiceContextPayload {
  readonly choiceContextData: Record<string, unknown>;
  readonly disclosedContracts: readonly unknown[];
  readonly synchronizerId?: string;
}

interface WalletGatewayPrepareResponse {
  readonly sessionId?: string | null;
  readonly expectedPublicKey?: string | null;
  readonly prepared?: {
    readonly preparedTransactionHash?: string | null;
  } | null;
}

// Instrument ids and registrar prefixes are intentionally empty by
// default. Callers must supply the values that match their deployment
// via the adapter constructor; we no longer carry organization- or
// instrument-specific defaults in the OSS SDK.
const DEFAULT_INSTRUMENT_IDS: readonly string[] = [];
const DEFAULT_REGISTRAR_PREFIXES: readonly string[] = [];
const DEFAULT_TRANSFER_FACTORY_PATH_TEMPLATE =
  '/registrars/{admin}/registry/transfer-instruction/v1/transfer-factory';
const DEFAULT_TRANSFER_FACTORY_TEMPLATE =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';
const DEFAULT_TRANSFER_EXECUTE_BEFORE_SEC = 86_400;

/**
 * @deprecated The settlement-reference path is replaced by V2
 * AllocationRequest. Use `dispatchSettlement` from
 * `settlement/allocation-dispatch.ts`.
 */
export class TransferOfferAdapter implements SettlementAdapter {
  private readonly baseUrl?: string;
  private readonly transferPath: string;
  private readonly jsonApiUrl?: string;
  private readonly ledgerToken?: string;
  private readonly ledgerUserId?: string;
  private readonly synchronizerId?: string;
  private readonly registryApiBase?: string;
  private readonly registryToken?: string;
  private readonly transferFactoryPathTemplate: string;
  private readonly transferFactoryTemplate: string;
  private readonly transferExecuteBeforeSec: number;
  private readonly instrumentIds: ReadonlySet<string>;
  private readonly registrarPrefixes: readonly string[];
  private readonly walletTransferTotalTimeoutMs?: number;
  private readonly cip56MaxAttempts?: number;
  private readonly cip56MaxCommandAttempts?: number;
  private readonly cip56SubmitTimeoutMs?: number;
  private readonly pendingPollAttempts: number;
  private readonly pendingPollIntervalMs: number;
  private readonly credentials: Readonly<Record<string, HostedWalletPartyCredentials>>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TransferOfferAdapterConfig = {}) {
    this.baseUrl = trimToUndefined(
      config.baseUrl ??
        process.env['CANTON_STREAMS_HOST_WALLET_URL'] ??
        process.env['CANTON_STREAMS_WALLET_GATEWAY_URL'] ??
        process.env['WALLET_GATEWAY_URL'],
    )?.replace(/\/+$/, '');
    this.transferPath =
      trimToUndefined(
        config.transferPath ?? process.env['CANTON_STREAMS_TRANSFER_OFFER_TRANSFER_PATH'],
      ) ?? '/api/wallet/transfer';
    this.jsonApiUrl = trimToUndefined(
      config.jsonApiUrl ?? process.env['CANTON_JSON_API_URL'],
    )?.replace(/\/+$/, '');
    this.ledgerToken = trimToUndefined(
      config.ledgerToken ?? process.env['CANTON_LEDGER_TOKEN'] ?? process.env['LEDGER_TOKEN'],
    );
    this.ledgerUserId = trimToUndefined(
      config.ledgerUserId ??
        process.env['CANTON_USER_ID'] ??
        process.env['COMMAND_USER_ID'] ??
        process.env['CANTON_JSON_API_TOKEN_SUB'],
    );
    this.synchronizerId = trimToUndefined(
      config.synchronizerId ??
        process.env['CANTON_STREAMS_WALLET_GATEWAY_SYNCHRONIZER_ID'] ??
        process.env['SYNCHRONIZER_ID'],
    );
    this.registryApiBase = trimToUndefined(
      config.registryApiBase ??
        process.env['CANTON_STREAMS_DA_TOKEN_STANDARD_API'] ??
        process.env['DA_TOKEN_STANDARD_API'] ??
        process.env['TOKEN_STANDARD_API_BASE'] ??
        process.env['REGISTRY_API_BASE'],
    )?.replace(/\/+$/, '');
    this.registryToken = trimToUndefined(
      config.registryToken ??
        process.env['CANTON_STREAMS_REGISTRY_API_TOKEN'] ??
        process.env['REGISTRY_API_TOKEN'],
    );
    this.transferFactoryPathTemplate =
      trimToUndefined(
        config.transferFactoryPathTemplate ??
          process.env['CANTON_STREAMS_TRANSFER_FACTORY_PATH_TEMPLATE'],
      ) ?? DEFAULT_TRANSFER_FACTORY_PATH_TEMPLATE;
    this.transferFactoryTemplate =
      trimToUndefined(
        config.transferFactoryTemplate ?? process.env['CANTON_STREAMS_TRANSFER_FACTORY_TEMPLATE'],
      ) ?? DEFAULT_TRANSFER_FACTORY_TEMPLATE;
    this.transferExecuteBeforeSec =
      parsePositiveInt(
        config.transferExecuteBeforeSec ??
          process.env['CANTON_STREAMS_TRANSFER_EXECUTE_BEFORE_SEC'],
      ) ?? DEFAULT_TRANSFER_EXECUTE_BEFORE_SEC;
    this.instrumentIds = new Set(
      readCsv(
        config.instrumentIds ?? process.env['CANTON_STREAMS_TRANSFER_OFFER_INSTRUMENT_IDS'],
        DEFAULT_INSTRUMENT_IDS,
      ).map(normalizeInstrumentId),
    );
    this.registrarPrefixes = readCsv(
      config.registrarPrefixes ?? process.env['CANTON_STREAMS_TRANSFER_OFFER_REGISTRAR_PREFIXES'],
      DEFAULT_REGISTRAR_PREFIXES,
    );
    this.walletTransferTotalTimeoutMs = parsePositiveInt(
      config.walletTransferTotalTimeoutMs ??
        process.env['CANTON_STREAMS_TRANSFER_OFFER_TOTAL_TIMEOUT_MS'],
    );
    this.cip56MaxAttempts = parsePositiveInt(
      config.cip56MaxAttempts ?? process.env['CANTON_STREAMS_TRANSFER_OFFER_MAX_ATTEMPTS'],
    );
    this.cip56MaxCommandAttempts = parsePositiveInt(
      config.cip56MaxCommandAttempts ??
        process.env['CANTON_STREAMS_TRANSFER_OFFER_MAX_COMMAND_ATTEMPTS'],
    );
    this.cip56SubmitTimeoutMs = parsePositiveInt(
      config.cip56SubmitTimeoutMs ?? process.env['CANTON_STREAMS_TRANSFER_OFFER_SUBMIT_TIMEOUT_MS'],
    );
    this.pendingPollAttempts =
      parsePositiveInt(
        config.pendingPollAttempts ??
          process.env['CANTON_STREAMS_TRANSFER_OFFER_PENDING_POLL_ATTEMPTS'],
      ) ?? 24;
    this.pendingPollIntervalMs =
      parsePositiveInt(
        config.pendingPollIntervalMs ??
          process.env['CANTON_STREAMS_TRANSFER_OFFER_PENDING_POLL_INTERVAL_MS'],
      ) ?? 2_500;
    this.credentials = {
      ...readHostedWalletCredentialMapFromEnv(),
      ...(config.credentials ?? {}),
    };
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async canHandle(registrar: string, instrumentId: string): Promise<boolean> {
    const normalizedInstrumentId = normalizeInstrumentId(instrumentId);
    if (this.instrumentIds.has(normalizedInstrumentId)) {
      return true;
    }

    const prefix = registrar.split('::')[0] ?? registrar;
    return this.registrarPrefixes.some((candidate) =>
      prefix.toLowerCase().includes(candidate.toLowerCase()),
    );
  }

  async transfer(
    params: TransferParams,
    _actAs: string[],
    _transport: Transport,
    logger: Logger,
  ): Promise<TransferResult> {
    if (!this.baseUrl) {
      throw new Error(
        'DA Utility / TransferOffer settlement requires CANTON_STREAMS_HOST_WALLET_URL ' +
          '(or CANTON_STREAMS_WALLET_GATEWAY_URL / WALLET_GATEWAY_URL) pointing at a host app ' +
          'that exposes /api/wallet/transfer and /api/wallet-gateway/*.',
      );
    }

    const senderCredentials = this.resolvePartyCredentials(params.from);
    const senderSigningCredentials = this.resolveOptionalSigningCredentials(params.from);
    const receiverCredentials = this.resolveSigningCredentials(params.to);
    const requestId = params.reference ?? `streams-transfer-${Date.now()}`;
    const memo = params.reference ?? requestId;
    const pendingSnapshot = await this.snapshotPendingTransfers(
      params.to,
      receiverCredentials.appToken,
    );

    logger.info(
      {
        from: params.from.split('::')[0],
        to: params.to.split('::')[0],
        amount: params.amount.toFixed(10),
        instrumentId: params.instrumentId,
      },
      'TransferOfferAdapter: creating hosted token-standard transfer',
    );

    let transferResponse: Record<string, unknown>;
    if (senderSigningCredentials && this.canUseInteractiveSenderTransfer()) {
      try {
        transferResponse = await this.createInteractiveTransferFactoryTransfer(
          params,
          memo,
          senderSigningCredentials,
        );
      } catch (error) {
        logger.warn(
          {
            from: params.from.split('::')[0],
            to: params.to.split('::')[0],
            instrumentId: params.instrumentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'TransferOfferAdapter: interactive sender transfer failed, falling back to hosted wallet transfer',
        );
        transferResponse = await this.requestJson<Record<string, unknown>>(
          this.transferPath,
          {
            party: params.from,
            toParty: params.to,
            symbol: params.instrumentId,
            instrumentId: params.instrumentId,
            instrumentAdmin: params.registrar,
            amount: params.amount.toFixed(10),
            memo,
            cip56FallbackEnabled: true,
            ...(this.walletTransferTotalTimeoutMs
              ? { walletTransferTotalTimeoutMs: this.walletTransferTotalTimeoutMs }
              : {}),
            ...(this.cip56MaxAttempts ? { cip56MaxAttempts: this.cip56MaxAttempts } : {}),
            ...(this.cip56MaxCommandAttempts
              ? { cip56MaxCommandAttempts: this.cip56MaxCommandAttempts }
              : {}),
            ...(this.cip56SubmitTimeoutMs
              ? { cip56SubmitTimeoutMs: this.cip56SubmitTimeoutMs }
              : {}),
          },
          senderCredentials.appToken,
        );
      }
    } else {
      transferResponse = await this.requestJson<Record<string, unknown>>(
        this.transferPath,
        {
          party: params.from,
          toParty: params.to,
          symbol: params.instrumentId,
          instrumentId: params.instrumentId,
          instrumentAdmin: params.registrar,
          amount: params.amount.toFixed(10),
          memo,
          cip56FallbackEnabled: true,
          ...(this.walletTransferTotalTimeoutMs
            ? { walletTransferTotalTimeoutMs: this.walletTransferTotalTimeoutMs }
            : {}),
          ...(this.cip56MaxAttempts ? { cip56MaxAttempts: this.cip56MaxAttempts } : {}),
          ...(this.cip56MaxCommandAttempts
            ? { cip56MaxCommandAttempts: this.cip56MaxCommandAttempts }
            : {}),
          ...(this.cip56SubmitTimeoutMs ? { cip56SubmitTimeoutMs: this.cip56SubmitTimeoutMs } : {}),
        },
        senderCredentials.appToken,
      );
    }

    let pendingTransfer: PendingTransferRecord | null = null;
    try {
      pendingTransfer = await this.waitForPendingTransfer(
        params.to,
        receiverCredentials.appToken,
        pendingSnapshot,
        {
          sender: params.from,
          receiver: params.to,
          amount: params.amount,
          instrumentId: params.instrumentId,
          instrumentAdmin: params.registrar,
        },
      );
    } catch (error) {
      const settlementReference =
        extractCompletedSettlementReferenceFromTransferResponse(transferResponse);
      if (settlementReference) {
        logger.info(
          {
            from: params.from.split('::')[0],
            to: params.to.split('::')[0],
            settlementReference: settlementReference.slice(0, 32),
          },
          'TransferOfferAdapter: hosted transfer completed without a pending receiver accept',
        );
        return {
          settlementReference,
          amount: params.amount,
          receiverAccepted: true,
        };
      }
      throw error;
    }

    const execute = await this.acceptPendingTransfer(
      pendingTransfer,
      params.to,
      receiverCredentials,
    );
    const settlementReference = extractSettlementReferenceFromWalletGatewayResult(execute);

    logger.info(
      {
        from: params.from.split('::')[0],
        to: params.to.split('::')[0],
        pendingTransfer: pendingTransfer.contractId.slice(0, 32),
        settlementReference: settlementReference.slice(0, 32),
      },
      'TransferOfferAdapter: hosted transfer accepted by receiver',
    );

    return {
      settlementReference,
      amount: params.amount,
      receiverAccepted: true,
      pendingTransferContractId: pendingTransfer.contractId,
    };
  }

  private resolvePartyCredentials(party: string): TransferOfferPartyCredentials {
    const credentials = this.credentials[party];
    if (credentials?.appToken) {
      return {
        ...credentials,
        appToken: credentials.appToken,
      };
    }

    throw new Error(
      `No hosted wallet appToken configured for party ${party}. ` +
        'Provide it in CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON.',
    );
  }

  private resolveOptionalSigningCredentials(party: string): TransferOfferSigningCredentials | null {
    const credentials = this.credentials[party];
    if (
      credentials?.appToken &&
      credentials.publicKey &&
      (credentials.privateKey || credentials.privateKeyFile)
    ) {
      return {
        ...credentials,
        appToken: credentials.appToken,
        publicKey: credentials.publicKey,
      };
    }
    return null;
  }

  private resolveSigningCredentials(party: string): TransferOfferSigningCredentials {
    const credentials = this.resolveOptionalSigningCredentials(party);
    if (credentials) {
      return credentials;
    }

    throw new Error(
      `No hosted wallet signer configured for receiver party ${party}. ` +
        'TransferOffer settlement needs appToken, publicKey, and privateKey/privateKeyFile.',
    );
  }

  private canUseInteractiveSenderTransfer(): boolean {
    return Boolean(
      this.jsonApiUrl &&
        this.ledgerToken &&
        this.ledgerUserId &&
        this.synchronizerId &&
        this.registryApiBase,
    );
  }

  private async createInteractiveTransferFactoryTransfer(
    params: TransferParams,
    memo: string,
    credentials: TransferOfferSigningCredentials,
  ): Promise<Record<string, unknown>> {
    const inputHoldingCids = await this.findInputHoldingCids(
      params.from,
      params.instrumentId,
      params.registrar,
      params.amount,
    );
    if (inputHoldingCids.length === 0) {
      throw new Error(
        `No sender holdings found for ${params.instrumentId} at registrar ${params.registrar}; ` +
          `cannot submit TransferFactory_Transfer for ${params.from}.`,
      );
    }

    const referenceId = `${memo || params.reference || `streams-transfer-${Date.now()}`}-transfer-1`;
    const requestedAt = new Date().toISOString();
    const transferChoiceArgument = createTransferChoiceArgument(
      params,
      referenceId,
      requestedAt,
      inputHoldingCids,
      this.transferExecuteBeforeSec,
    );
    const registryPayload = await this.requestRegistryChoiceContext<Record<string, unknown>>(
      buildRegistryUrl(this.registryApiBase, this.transferFactoryPathTemplate, {
        admin: params.registrar,
      }),
      transferChoiceArgument,
    );
    const factoryId = pickFactoryId(registryPayload);
    if (!factoryId) {
      throw new Error(
        `Could not resolve transfer factory contract id from registry response for ${params.instrumentId}.`,
      );
    }

    const normalizedContext = normalizeChoiceContextPayload(registryPayload);
    const choiceArgumentWithContext = applyChoiceContextToChoiceArgument(
      transferChoiceArgument,
      normalizedContext,
    );

    return this.prepareAndExecuteInteractiveExercise(
      params.from,
      credentials,
      factoryId,
      choiceArgumentWithContext.choiceArgument,
      choiceArgumentWithContext.disclosedContracts,
      choiceArgumentWithContext.synchronizerId,
      `canton-streams.transfer.${sanitizeCommandId(referenceId)}.${Date.now()}`,
    );
  }

  private async findInputHoldingCids(
    senderParty: string,
    instrumentId: string,
    instrumentAdmin: string,
    amount: Decimal,
  ): Promise<string[]> {
    const holdings = await this.listHoldingCandidates(senderParty);
    return selectHoldingContractIds(
      holdings.filter((candidate) =>
        sameInstrument(candidate.instrument, {
          id: instrumentId,
          admin: instrumentAdmin,
        }),
      ),
      amount,
    );
  }

  private async listHoldingCandidates(senderParty: string): Promise<HoldingCandidate[]> {
    const ledgerEnd = await this.requestLedgerJson<{ offset?: string | number }>(
      '/v2/state/ledger-end',
      { method: 'GET' },
    );
    const offset = ledgerEnd?.offset;
    if (offset === undefined || offset === null) {
      throw new Error(`ledger-end response missing offset: ${JSON.stringify(ledgerEnd)}`);
    }

    const payload = await this.requestLedgerJson<unknown>('/v2/state/active-contracts', {
      method: 'POST',
      body: {
        userId: this.ledgerUserId,
        activeAtOffset: offset,
        filter: {
          filtersByParty: {
            [senderParty]: {
              cumulative: [
                {
                  identifierFilter: {
                    WildcardFilter: {
                      value: {
                        includeCreatedEventBlob: false,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        verbose: true,
      },
    });

    return extractHoldingCandidates(payload, senderParty);
  }

  private async prepareAndExecuteInteractiveExercise(
    party: string,
    credentials: TransferOfferSigningCredentials,
    contractId: string,
    choiceArgument: Record<string, unknown>,
    disclosedContracts: readonly unknown[],
    disclosedSynchronizerId: string | undefined,
    commandId: string,
  ): Promise<Record<string, unknown>> {
    const synchronizerId = trimToUndefined(disclosedSynchronizerId) ?? this.synchronizerId;
    if (!synchronizerId) {
      throw new Error(`TransferFactory interactive submit for ${party} requires SYNCHRONIZER_ID.`);
    }

    const prepared = await this.requestLedgerJson<InteractivePrepareResponse>(
      '/v2/interactive-submission/prepare',
      {
        method: 'POST',
        body: {
          userId: this.ledgerUserId,
          commandId,
          commands: [
            {
              ExerciseCommand: {
                templateId: this.transferFactoryTemplate,
                contractId,
                choice: 'TransferFactory_Transfer',
                choiceArgument,
              },
            },
          ],
          actAs: [party],
          readAs: [],
          synchronizerId,
          disclosedContracts,
          verboseHashing: false,
          packageIdSelectionPreference: [],
        },
      },
    );

    const preparedTransactionHash = trimToUndefined(prepared.preparedTransactionHash);
    const preparedTransaction = trimToUndefined(prepared.preparedTransaction);
    if (!preparedTransactionHash || !preparedTransaction) {
      throw new Error(`Interactive prepare response missing hash/transaction for ${party}.`);
    }

    const executePayload = {
      userId: this.ledgerUserId,
      preparedTransaction,
      hashingSchemeVersion:
        trimToUndefined(prepared.hashingSchemeVersion) ?? 'HASHING_SCHEME_VERSION_V2',
      submissionId: commandId,
      deduplicationPeriod:
        prepared.deduplicationPeriod && typeof prepared.deduplicationPeriod === 'object'
          ? prepared.deduplicationPeriod
          : { Empty: {} },
      partySignatures: {
        signatures: [
          {
            party,
            signatures: [
              {
                signature: signPreparedHash(preparedTransactionHash, credentials),
                signedBy: fingerprintFromParty(party),
                format: 'SIGNATURE_FORMAT_CONCAT',
                signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519',
              },
            ],
          },
        ],
      },
    };

    try {
      return await this.requestLedgerJson<Record<string, unknown>>(
        '/v2/interactive-submission/executeAndWait',
        {
          method: 'POST',
          body: executePayload,
        },
      );
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).toLowerCase();
      const shouldFallback =
        message.includes('404') ||
        message.includes('405') ||
        message.includes('method not allowed') ||
        message.includes('unsupported endpoint') ||
        message.includes('not found');
      if (!shouldFallback) {
        throw error;
      }

      return this.requestLedgerJson<Record<string, unknown>>('/v2/interactive-submission/execute', {
        method: 'POST',
        body: executePayload,
      });
    }
  }

  private async requestRegistryJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
    // No-redirect + abort timeout: a 3xx must not replay the bearer token.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.registryToken ? { authorization: `Bearer ${this.registryToken}` } : {}),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const rendered = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      throw new Error(`HTTP ${response.status} registry ${url}: ${rendered}`);
    }

    return (payload ?? {}) as T;
  }

  private async requestRegistryChoiceContext<T>(
    url: string,
    choiceArgument: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.requestRegistryJson<T>(url, {
        choiceArguments: choiceArgument,
        excludeDebugFields: false,
      });
    } catch (firstError) {
      try {
        return await this.requestRegistryJson<T>(url, choiceArgument);
      } catch (secondError) {
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        const secondMessage =
          secondError instanceof Error ? secondError.message : String(secondError);
        throw new Error(`${firstMessage}; fallback request also failed: ${secondMessage}`);
      }
    }
  }

  private async requestLedgerJson<T>(
    path: string,
    options: {
      readonly method: 'GET' | 'POST';
      readonly body?: Record<string, unknown>;
    },
  ): Promise<T> {
    if (!this.jsonApiUrl || !this.ledgerToken) {
      throw new Error(
        'Interactive token-standard transfer requires CANTON_JSON_API_URL and CANTON_LEDGER_TOKEN.',
      );
    }

    // No-redirect + abort timeout: a 3xx must not replay the bearer token.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.jsonApiUrl}${path}`, {
        method: options.method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.ledgerToken}`,
        },
        redirect: 'error',
        signal: ac.signal,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const rendered = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      throw new Error(`HTTP ${response.status} ${path}: ${rendered}`);
    }

    return (payload ?? {}) as T;
  }

  private async snapshotPendingTransfers(party: string, token: string): Promise<Set<string>> {
    const rows = await this.listPendingTransfers(party, token);
    return new Set(rows.map((row) => row.contractId));
  }

  private async listPendingTransfers(
    party: string,
    token: string,
  ): Promise<PendingTransferRecord[]> {
    const payload = await this.requestJson<unknown>(
      '/api/wallet/pending-transfers',
      undefined,
      token,
      party,
    );

    const record = asRecord(payload);
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(record['pending'])
        ? (record['pending'] as unknown[])
        : Array.isArray(record['pendingTransfers'])
          ? (record['pendingTransfers'] as unknown[])
          : Array.isArray(record['result'])
            ? (record['result'] as unknown[])
            : [];

    return rows
      .map(deserializePendingTransfer)
      .filter((row): row is PendingTransferRecord => Boolean(row?.contractId));
  }

  private async waitForPendingTransfer(
    party: string,
    token: string,
    excludedContractIds: ReadonlySet<string>,
    expected: {
      readonly sender: string;
      readonly receiver: string;
      readonly amount: Decimal;
      readonly instrumentId: string;
      readonly instrumentAdmin: string;
    },
  ): Promise<PendingTransferRecord> {
    for (let attempt = 1; attempt <= this.pendingPollAttempts; attempt += 1) {
      const rows = await this.listPendingTransfers(party, token);
      const match = findMatchingPendingTransfer(rows, excludedContractIds, expected);
      if (match) {
        return match;
      }
      if (attempt < this.pendingPollAttempts) {
        await sleep(this.pendingPollIntervalMs);
      }
    }

    throw new Error(
      `Pending transfer for ${expected.instrumentId} from ${expected.sender.split('::')[0]} ` +
        `to ${party.split('::')[0]} did not appear after ${this.pendingPollAttempts} attempts.`,
    );
  }

  private async acceptPendingTransfer(
    pendingTransfer: PendingTransferRecord,
    party: string,
    credentials: TransferOfferSigningCredentials,
  ): Promise<WalletGatewayExecuteResponse> {
    const prepared = await this.requestJson<WalletGatewayPrepareResponse>(
      '/api/wallet-gateway/prepare-action',
      {
        action: 'transfer_accept',
        party,
        requestId: `streams-transfer-accept-${Date.now()}`,
        payload: {
          contractId: pendingTransfer.contractId,
          ...(pendingTransfer.templateId ? { templateId: pendingTransfer.templateId } : {}),
          ...(pendingTransfer.instrumentId ? { instrumentId: pendingTransfer.instrumentId } : {}),
          ...(pendingTransfer.instrumentAdmin
            ? { instrumentAdmin: pendingTransfer.instrumentAdmin }
            : {}),
        },
      },
      credentials.appToken,
    );

    const preparedHash = trimToUndefined(prepared.prepared?.preparedTransactionHash);
    const sessionId = trimToUndefined(prepared.sessionId);
    if (!preparedHash || !sessionId) {
      throw new Error(
        `wallet-gateway prepare-action did not return a signable transfer_accept session for ${party}.`,
      );
    }

    const expectedPublicKey = trimToUndefined(prepared.expectedPublicKey);
    if (expectedPublicKey && expectedPublicKey !== credentials.publicKey) {
      throw new Error(
        `wallet-gateway expected public key ${expectedPublicKey}, ` +
          `but the configured signer for ${party} uses ${credentials.publicKey}.`,
      );
    }

    return this.requestJson<WalletGatewayExecuteResponse>(
      '/api/wallet-gateway/execute-action',
      {
        party,
        sessionId,
        publicKey: credentials.publicKey,
        signature: signPreparedHash(preparedHash, credentials),
      },
      credentials.appToken,
    );
  }

  private async requestJson<T>(
    path: string,
    body: Record<string, unknown> | undefined,
    token: string,
    party?: string,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (party && path === '/api/wallet/pending-transfers') {
      url.searchParams.set('party', party);
    }

    // No-redirect + abort timeout: a 3xx must not replay the bearer token.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        redirect: 'error',
        signal: ac.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const rendered = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      throw new Error(`HTTP ${response.status} hosted wallet ${path}: ${rendered}`);
    }

    return (payload ?? {}) as T;
  }
}

function normalizeInstrumentId(value: string): string {
  return String(value ?? '')
    .trim()
    .toUpperCase();
}

function fingerprintFromParty(party: string): string {
  const parts = String(party || '').split('::');
  return parts[parts.length - 1] ?? '';
}

function sanitizeCommandId(value: string): string {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function buildRegistryUrl(
  baseUrl: string | undefined,
  pathTemplate: string,
  values: Record<string, string>,
): string {
  const normalizedBase = trimToUndefined(baseUrl);
  if (!normalizedBase) {
    throw new Error(
      'DA token-standard transfer requires DA_TOKEN_STANDARD_API / REGISTRY_API_BASE.',
    );
  }

  const renderedPath = pathTemplate.replace(/\{([^}]+)\}/g, (_match, key) =>
    encodeURIComponent(String(values[key] ?? '').trim()),
  );
  return `${normalizedBase}${renderedPath}`;
}

function createTransferChoiceArgument(
  params: TransferParams,
  referenceId: string,
  requestedAt: string,
  inputHoldingCids: readonly string[],
  executeBeforeSec: number,
): Record<string, unknown> {
  const executeBefore = new Date(Date.now() + executeBeforeSec * 1000).toISOString();
  const metaValues = sanitizeMetaValues({
    source: 'canton-streams',
    action: 'TRANSFER',
    requestId: params.reference ?? '',
    referenceId,
    leg: 'transfer',
  });

  return {
    expectedAdmin: params.registrar,
    transfer: {
      sender: params.from,
      receiver: params.to,
      amount: params.amount.toFixed(10),
      instrumentId: {
        id: params.instrumentId,
        admin: params.registrar,
      },
      requestedAt,
      executeBefore,
      inputHoldingCids: [...inputHoldingCids],
      meta: {
        values: metaValues,
      },
    },
    extraArgs: {
      context: { values: {} },
      meta: {
        values: metaValues,
      },
    },
  };
}

function applyChoiceContextToChoiceArgument(
  choiceArgument: Record<string, unknown>,
  context: NormalizedChoiceContextPayload,
): {
  readonly choiceArgument: Record<string, unknown>;
  readonly disclosedContracts: readonly unknown[];
  readonly synchronizerId?: string;
} {
  const currentExtraArgs = asRecord(choiceArgument['extraArgs']);
  return {
    choiceArgument: {
      ...choiceArgument,
      extraArgs: {
        ...currentExtraArgs,
        context: context.choiceContextData,
        meta: currentExtraArgs['meta'] ?? { values: {} },
      },
    },
    disclosedContracts: context.disclosedContracts,
    synchronizerId: context.synchronizerId,
  };
}

function normalizeChoiceContextPayload(
  rawPayload: Record<string, unknown>,
): NormalizedChoiceContextPayload {
  const choiceContext = asRecord(rawPayload['choiceContext']);
  const context = asRecord(rawPayload['context']);
  const contextHolder =
    Object.keys(choiceContext).length > 0
      ? choiceContext
      : Object.keys(context).length > 0
        ? context
        : rawPayload;
  const disclosedContractsRaw =
    contextHolder['disclosedContracts'] ?? rawPayload['disclosedContracts'] ?? [];

  return {
    choiceContextData: firstNonEmptyRecord(
      contextHolder['choiceContextData'],
      rawPayload['choiceContextData'],
    ),
    disclosedContracts: Array.isArray(disclosedContractsRaw) ? disclosedContractsRaw : [],
    synchronizerId:
      trimToUndefined(asText(contextHolder['synchronizerId'])) ??
      trimToUndefined(asText(contextHolder['synchronizer_id'])) ??
      trimToUndefined(asText(rawPayload['synchronizerId'])) ??
      trimToUndefined(asText(rawPayload['synchronizer_id'])),
  };
}

function pickFactoryId(rawPayload: Record<string, unknown>): string {
  return (
    trimToUndefined(
      asText(rawPayload['factoryId']) ??
        asText(rawPayload['factoryCid']) ??
        asText(rawPayload['contractId']) ??
        asText(asRecord(rawPayload['factory'])['contractId']) ??
        asText(asRecord(rawPayload['factory'])['id']) ??
        asText(asRecord(rawPayload['result'])['factoryId']),
    ) ?? ''
  );
}

function sanitizeMetaValues(values: Record<string, unknown>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const rendered = trimToUndefined(value === undefined || value === null ? '' : String(value));
    if (rendered) {
      sanitized[key] = rendered;
    }
  }
  return sanitized;
}

function extractHoldingCandidates(payload: unknown, senderParty: string): HoldingCandidate[] {
  return extractActiveContractRows(payload).reduce<HoldingCandidate[]>((out, row) => {
    const source = row.payload;
    const owner =
      trimToUndefined(
        asText(source['owner']) ??
          asText(source['holder']) ??
          asText(asRecord(source['account'])['owner']),
      ) ?? senderParty;
    if (owner !== senderParty) {
      return out;
    }

    const instrument = parseInstrument(source['instrumentId'] ?? source['instrument']);
    const amount = parseDecimal(
      source['amount'] ??
        source['initialAmount'] ??
        source['availableAmount'] ??
        source['unlockedAmount'],
    );
    if (!instrument || !amount) {
      return out;
    }

    out.push({
      contractId: row.contractId,
      instrument,
      amount,
    });
    return out;
  }, []);
}

function extractActiveContractRows(
  payload: unknown,
): Array<{ contractId: string; templateId: string; payload: Record<string, unknown> }> {
  const record = asRecord(payload);
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(record['activeContracts'])
      ? (record['activeContracts'] as unknown[])
      : Array.isArray(record['result'])
        ? (record['result'] as unknown[])
        : [];

  return rows
    .map((entry) => {
      const created = asRecord(
        asRecord(asRecord(asRecord(entry)['contractEntry'])['JsActiveContract'])['createdEvent'],
      );
      const contractId =
        trimToUndefined(asText(created['contractId']) ?? asText(created['contract_id'])) ?? '';
      if (!contractId) {
        return null;
      }
      const payloadRecord = firstNonEmptyRecord(
        created['createArguments'],
        created['createArgument'],
        created['create_arguments'],
      );

      return {
        contractId,
        templateId: normalizeTemplateId(created['templateId'] ?? created['template_id']),
        payload: payloadRecord,
      };
    })
    .filter(
      (row): row is { contractId: string; templateId: string; payload: Record<string, unknown> } =>
        Boolean(row?.contractId),
    );
}

function normalizeTemplateId(value: unknown): string {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  const record = asRecord(value);
  const packageId = asText(record['packageId']) ?? asText(record['package_id']) ?? '';
  const moduleName = asText(record['moduleName']) ?? asText(record['module_name']) ?? '';
  const entityName = asText(record['entityName']) ?? asText(record['entity_name']) ?? '';
  return [packageId, moduleName, entityName].filter(Boolean).join(':');
}

function parseInstrument(value: unknown): { id: string; admin?: string } | null {
  const record = asRecord(value);
  const id = trimToUndefined(asText(record['id']) ?? asText(record['instrumentId']));
  if (!id) {
    return null;
  }

  const admin = trimToUndefined(
    asText(record['admin']) ??
      asText(record['issuer']) ??
      asText(record['instrumentAdmin']) ??
      asText(record['source']) ??
      asText(record['registrar']),
  );
  return admin ? { id, admin } : { id };
}

function parseDecimal(value: unknown): Decimal | null {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const rendered = String(value).trim();
    if (!rendered) {
      return null;
    }
    try {
      return new Decimal(rendered);
    } catch {
      return null;
    }
  }
  return null;
}

function sameInstrument(
  left: { id: string; admin?: string } | null,
  right: { id: string; admin?: string } | null,
): boolean {
  if (!left || !right) {
    return false;
  }
  return (
    normalizeInstrumentId(left.id) === normalizeInstrumentId(right.id) &&
    canonicalParty(left.admin) === canonicalParty(right.admin)
  );
}

function canonicalParty(value: string | undefined): string {
  return trimToUndefined(value)?.toLowerCase() ?? '';
}

function selectHoldingContractIds(
  holdings: readonly HoldingCandidate[],
  amount: Decimal,
): string[] {
  const sorted = holdings.slice().sort((left, right) => right.amount.comparedTo(left.amount));
  const selected: string[] = [];
  let total = new Decimal(0);

  for (const holding of sorted) {
    selected.push(holding.contractId);
    total = total.plus(holding.amount);
    if (total.greaterThanOrEqualTo(amount)) {
      break;
    }
  }

  return total.greaterThanOrEqualTo(amount) ? selected : [];
}

function readCsv(
  value: readonly string[] | string | undefined,
  fallback: readonly string[],
): string[] {
  if (Array.isArray(value)) {
    const rows = value.map((row) => row.trim()).filter(Boolean);
    return rows.length > 0 ? rows : [...fallback];
  }

  const rendered = typeof value === 'string' ? trimToUndefined(value) : undefined;
  if (!rendered) {
    return [...fallback];
  }

  return rendered
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: number | string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.trunc(parsed);
}

function deserializePendingTransfer(raw: unknown): PendingTransferRecord | null {
  const record = asRecord(raw);
  const contractId = asText(record['contractId']) ?? asText(record['contract_id']) ?? '';
  if (!contractId) {
    return null;
  }

  const amountText =
    asText(record['amount']) ??
    (typeof record['amount'] === 'number' ? String(record['amount']) : undefined);
  const instrumentRecord = asRecord(record['instrument']);

  return {
    contractId,
    templateId: asText(record['templateId']) ?? asText(record['template_id']) ?? undefined,
    sender: asText(record['sender']) || undefined,
    receiver: asText(record['receiver']) || undefined,
    amount: amountText ? new Decimal(amountText) : undefined,
    instrumentId:
      asText(instrumentRecord['id']) ??
      asText(record['instrumentId']) ??
      asText(record['instrument_id']) ??
      undefined,
    instrumentAdmin:
      asText(instrumentRecord['admin']) ??
      asText(record['instrumentAdmin']) ??
      asText(record['instrument_admin']) ??
      undefined,
    requestedAt: record['requestedAt'] ? deserializeTime(record['requestedAt']) : undefined,
    expired: asBoolean(record['expired'], false) || asBoolean(record['isExpired'], false),
  };
}

function findMatchingPendingTransfer(
  rows: readonly PendingTransferRecord[],
  excludedContractIds: ReadonlySet<string>,
  expected: {
    readonly sender: string;
    readonly receiver: string;
    readonly amount: Decimal;
    readonly instrumentId: string;
    readonly instrumentAdmin: string;
  },
): PendingTransferRecord | null {
  const matches = rows
    .filter(
      (row) =>
        !excludedContractIds.has(row.contractId) &&
        !row.expired &&
        row.sender === expected.sender &&
        row.receiver === expected.receiver &&
        row.amount?.equals(expected.amount) &&
        (!row.instrumentId ||
          normalizeInstrumentId(row.instrumentId) ===
            normalizeInstrumentId(expected.instrumentId)) &&
        (!row.instrumentAdmin || row.instrumentAdmin === expected.instrumentAdmin),
    )
    .sort(comparePendingTransferPriority);

  return matches[0] ?? null;
}

function comparePendingTransferPriority(
  left: PendingTransferRecord,
  right: PendingTransferRecord,
): number {
  const requestedAtOrder = (right.requestedAt?.getTime() ?? 0) - (left.requestedAt?.getTime() ?? 0);
  if (requestedAtOrder !== 0) {
    return requestedAtOrder;
  }
  return right.contractId.localeCompare(left.contractId);
}

function extractCompletedSettlementReferenceFromTransferResponse(
  payload: Record<string, unknown>,
): string | undefined {
  const candidates = [
    readNestedTextField(payload, ['settlementReference']),
    readNestedTextField(payload, ['transfer', 'settlementReference']),
    readNestedTextField(payload, ['updateId']),
    readNestedTextField(payload, ['result', 'updateId']),
    readNestedTextField(payload, ['completion', 'updateId']),
    readNestedTextField(payload, ['settlement', 'completionUpdateId']),
    readNestedTextField(payload, ['transfer', 'settlement', 'completionUpdateId']),
    readNestedTextField(payload, ['settlement', 'completion', 'updateId']),
    readNestedTextField(payload, ['transfer', 'settlement', 'completion', 'updateId']),
    readNestedTextField(payload, ['settlement', 'externalTransactionHash']),
    readNestedTextField(payload, ['transfer', 'settlement', 'externalTransactionHash']),
    readNestedTextField(payload, ['commandId']),
    readNestedTextField(payload, [
      'settlement',
      'acceptResult',
      'externalSigning',
      'completionUpdateId',
    ]),
    readNestedTextField(payload, [
      'transfer',
      'settlement',
      'acceptResult',
      'externalSigning',
      'completionUpdateId',
    ]),
    readNestedTextField(payload, ['settlement', 'acceptResult', 'externalTransactionHash']),
    readNestedTextField(payload, [
      'transfer',
      'settlement',
      'acceptResult',
      'externalTransactionHash',
    ]),
  ];

  for (const candidate of candidates) {
    const rendered = trimToUndefined(candidate);
    if (rendered) {
      return rendered;
    }
  }
  return undefined;
}

function readNestedTextField(value: unknown, path: readonly string[]): string | undefined {
  let cursor: unknown = value;
  for (const step of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[step];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstNonEmptyRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = asRecord(value);
    if (Object.keys(record).length > 0) {
      return record;
    }
  }
  return {};
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function deserializeTime(value: unknown): Date {
  if (typeof value === 'string') {
    return new Date(value);
  }

  const record = asRecord(value);
  const timestamp = asText(record['timestamp']) ?? asText(record['value']);
  if (timestamp) {
    return new Date(timestamp);
  }

  return new Date(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
