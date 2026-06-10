/**
 * @module settlement/adapters/amulet
 *
 * AmuletWalletGatewayAdapter — settlement via a validator-hosted wallet-gateway.
 *
 * This adapter automates native CC / Amulet transfers for TokenStandardCustody
 * streams by calling the validator app's wallet-gateway prepare/execute APIs and
 * signing the prepared hash with the configured wallet key for the sending party.
 *
 * The adapter is intentionally generic:
 *   - it does not assume CantonAMM contracts
 *   - it only depends on the hosted wallet-gateway interface
 *   - credentials are resolved by party ID, so any dapp/operator can provide
 *     the right signer for its escrow party (and optionally other parties)
 */

import type { Logger } from 'pino';
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

export interface WalletGatewayPartyCredentials extends HostedWalletPartyCredentials {
  readonly appToken: string;
  readonly publicKey: string;
  readonly privateKey?: string;
  readonly privateKeyFile?: string;
}

export interface AmuletWalletGatewayAdapterConfig {
  readonly baseUrl?: string;
  readonly synchronizerId?: string;
  readonly action?: string;
  readonly credentials?: Readonly<Record<string, HostedWalletPartyCredentials>>;
  readonly fetchImpl?: typeof fetch;
}

interface WalletGatewayPrepareResponse {
  readonly sessionId?: string | null;
  readonly expectedPublicKey?: string | null;
  readonly action?: string | null;
  readonly prepared?: {
    readonly preparedTransactionHash?: string | null;
    readonly synchronizerId?: string | null;
  } | null;
}

const AMULET_INSTRUMENT_IDS = new Set(['AMULET', 'CC']);

/**
 * @deprecated Use the V2 AllocationRequest dispatcher and SigningProvider
 * wallet-gateway path instead.
 *
 * **Two layers of deprecation apply here**:
 *
 * 1. The settlement-reference path (prepare-action / execute-action via
 *    the wallet-gateway) is replaced by the V2 AllocationRequest
 *    pattern. Use `dispatchSettlement` from
 *    `settlement/allocation-dispatch.ts` instead.
 *
 * 2. The transport this adapter uses (`POST /api/wallet-gateway/prepare-action`
 *    + `POST /api/wallet-gateway/execute-action`) is not the current
 *    public Wallet Gateway dApp API. The current gateway uses JSON-RPC
 *    2.0 at `/api/v0/dapp`; `SigningProvider` wraps that API directly
 *    with per-party provider routing.
 *
 * For new code, prefer:
 *
 * ```typescript
 * import { createSigningFromEnv } from '@canton-streams/sdk';
 * const { resolver } = await createSigningFromEnv();
 * const provider = await resolver.forParty(escrowOperator);
 * await provider.prepareExecuteAndWait({ commands, actAs: [escrowOperator] });
 * ```
 *
 * This adapter remains only for backwards compatibility.
 */
export class AmuletWalletGatewayAdapter implements SettlementAdapter {
  private readonly baseUrl?: string;
  private readonly synchronizerId?: string;
  private readonly action: string;
  private readonly credentials: Readonly<Record<string, HostedWalletPartyCredentials>>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AmuletWalletGatewayAdapterConfig = {}) {
    this.baseUrl = trimToUndefined(
      config.baseUrl ??
        process.env['CANTON_STREAMS_WALLET_GATEWAY_URL'] ??
        process.env['WALLET_GATEWAY_URL'],
    )?.replace(/\/+$/, '');
    this.synchronizerId = trimToUndefined(
      config.synchronizerId ??
        process.env['CANTON_STREAMS_WALLET_GATEWAY_SYNCHRONIZER_ID'] ??
        process.env['SYNCHRONIZER_ID'],
    );
    this.action =
      trimToUndefined(
        config.action ??
          process.env['CANTON_STREAMS_WALLET_GATEWAY_ACTION_CC'] ??
          process.env['CANTON_STREAMS_WALLET_GATEWAY_ACTION'],
      ) ?? 'transfer_cc';
    this.credentials = {
      ...readHostedWalletCredentialMapFromEnv(),
      ...(config.credentials ?? {}),
    };
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async canHandle(_registrar: string, instrumentId: string): Promise<boolean> {
    return AMULET_INSTRUMENT_IDS.has(normalizeInstrumentId(instrumentId));
  }

  async transfer(
    params: TransferParams,
    _actAs: string[],
    _transport: Transport,
    logger: Logger,
  ): Promise<TransferResult> {
    if (!this.baseUrl) {
      throw new Error(
        'Amulet/CC settlement requires CANTON_STREAMS_WALLET_GATEWAY_URL ' +
          '(or WALLET_GATEWAY_URL) to point at a validator app exposing /api/wallet-gateway/*.',
      );
    }

    const credentials = this.resolveCredentials(params.from);
    const requestId = params.reference ?? `streams-transfer-${Date.now()}`;
    const memo = params.reference ?? requestId;

    logger.info(
      {
        from: params.from.split('::')[0],
        to: params.to.split('::')[0],
        amount: params.amount.toString(),
        action: this.action,
      },
      'AmuletWalletGatewayAdapter: preparing hosted transfer',
    );

    const prepare = await this.requestJson<WalletGatewayPrepareResponse>(
      '/api/wallet-gateway/prepare-action',
      {
        action: this.action,
        party: params.from,
        ...(this.synchronizerId ? { synchronizerId: this.synchronizerId } : {}),
        requestId,
        payload: {
          toParty: params.to,
          amount: params.amount.toFixed(10),
          memo,
        },
      },
      credentials.appToken,
    );

    const preparedHash = trimToUndefined(prepare.prepared?.preparedTransactionHash);
    const sessionId = trimToUndefined(prepare.sessionId);
    if (!preparedHash || !sessionId) {
      throw new Error(
        `wallet-gateway prepare-action did not return a signable session for ${params.from.split('::')[0]}.`,
      );
    }

    const expectedPublicKey = trimToUndefined(prepare.expectedPublicKey);
    if (expectedPublicKey && expectedPublicKey !== credentials.publicKey) {
      throw new Error(
        `wallet-gateway expected public key ${expectedPublicKey}, ` +
          `but the configured signer for ${params.from} uses ${credentials.publicKey}.`,
      );
    }

    const signature = signPreparedHash(preparedHash, credentials);
    const execute = await this.requestJson<WalletGatewayExecuteResponse>(
      '/api/wallet-gateway/execute-action',
      {
        party: params.from,
        sessionId,
        publicKey: credentials.publicKey,
        signature,
      },
      credentials.appToken,
    );

    if (execute._retryRequired) {
      throw new Error(
        `wallet-gateway transfer for ${params.from.split('::')[0]} requires an additional ` +
          `${trimToUndefined(execute._retryAction) ?? 'action'} before it can complete.`,
      );
    }

    const settlementReference = extractSettlementReferenceFromWalletGatewayResult(execute);

    logger.info(
      {
        from: params.from.split('::')[0],
        to: params.to.split('::')[0],
        settlementReference: settlementReference.slice(0, 32),
      },
      'AmuletWalletGatewayAdapter: hosted transfer complete',
    );

    return {
      settlementReference,
      amount: params.amount,
    };
  }

  private resolveCredentials(party: string): WalletGatewayPartyCredentials {
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

    throw new Error(
      `No wallet-gateway signer configured for party ${party}. ` +
        `Provide CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON or legacy sender/recipient/escrow operator env vars.`,
    );
  }

  private async requestJson<T>(
    path: string,
    body: Record<string, unknown>,
    token: string,
  ): Promise<T> {
    // Never follow a 3xx on an authenticated call (the default redirect
    // replays the Authorization header to the target), and bound the call
    // so a hung gateway cannot wedge the caller.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
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
      throw new Error(`HTTP ${response.status} wallet-gateway ${path}: ${rendered}`);
    }

    return (payload ?? {}) as T;
  }
}

function normalizeInstrumentId(value: string): string {
  return String(value ?? '')
    .trim()
    .toUpperCase();
}
