import Decimal from 'decimal.js';

export type HostWalletAdapterKind =
  | 'wallet-api-claim'
  | 'wallet-gateway-transfer-accept';

export interface WalletSigningCredentials {
  readonly appToken?: string;
  readonly publicKey: string;
  readonly privateKey?: string;
  readonly privateKeyFile?: string;
}

export interface PendingTransferRecord {
  readonly contractId: string;
  readonly sender?: string;
  readonly receiver?: string;
  readonly amount?: Decimal;
  readonly requestedAt?: Date;
  readonly expired: boolean;
}

export interface HostWalletClient {
  readonly adapter: HostWalletAdapterKind;
  listPendingTransfers(party: string): Promise<PendingTransferRecord[]>;
  claimPendingTransfer(party: string, contractId: string): Promise<void>;
}

export interface CreateHostWalletClientOptions {
  readonly baseUrl?: string;
  readonly adapter: HostWalletAdapterKind;
  readonly resolveCredentials: (party: string) => WalletSigningCredentials;
  readonly signPreparedHash: (
    preparedTransactionHash: string,
    credentials: WalletSigningCredentials,
  ) => string;
  readonly fetchImpl?: typeof fetch;
}

export function parseHostWalletAdapterKind(
  value: string | undefined,
): HostWalletAdapterKind {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return 'wallet-gateway-transfer-accept';
  }

  switch (normalized) {
    case 'wallet-api-claim':
    case 'wallet_api_claim':
    case 'claim':
      return 'wallet-api-claim';
    case 'wallet-gateway-transfer-accept':
    case 'wallet_gateway_transfer_accept':
    case 'wallet-gateway':
    case 'transfer_accept':
      return 'wallet-gateway-transfer-accept';
    default:
      throw new Error(
        `Unsupported PROXY_TOKEN_STANDARD_HOST_WALLET_ADAPTER value "${value}". ` +
        'Use "wallet-api-claim" or "wallet-gateway-transfer-accept".',
      );
  }
}

export function createHostWalletClient(
  options: CreateHostWalletClientOptions,
): HostWalletClient {
  const baseUrl = requireValue(
    trimToUndefined(options.baseUrl),
    'CANTON_STREAMS_WALLET_GATEWAY_URL',
  ).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function listPendingTransfers(party: string): Promise<PendingTransferRecord[]> {
    const credentials = options.resolveCredentials(party);
    if (!credentials.appToken) {
      throw new Error(
        'Listing pending transfers requires an appToken in ' +
        'CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON.',
      );
    }

    const payload = await requestJson<unknown>(
      fetchImpl,
      `${baseUrl}/api/wallet/pending-transfers`,
      credentials.appToken,
      { method: 'GET' },
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

  async function claimPendingTransferViaWalletApi(
    party: string,
    contractId: string,
  ): Promise<void> {
    const credentials = options.resolveCredentials(party);
    if (!credentials.appToken) {
      throw new Error(
        `Host-wallet claim requires an appToken for ${party}. ` +
        'Provide it in CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON.',
      );
    }

    try {
      await requestJson(
        fetchImpl,
        `${baseUrl}/api/wallet/pending-transfers/claim`,
        credentials.appToken,
        {
          method: 'POST',
          body: { contractId },
        },
      );
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).toLowerCase();
      const shouldFallback =
        message.includes('scripted users') ||
        message.includes('403') ||
        message.includes('404') ||
        message.includes('405') ||
        message.includes('method not allowed') ||
        message.includes('unsupported endpoint') ||
        message.includes('not found');

      if (!shouldFallback) {
        throw error;
      }

      await claimPendingTransferViaWalletGateway(party, contractId);
    }
  }

  async function claimPendingTransferViaWalletGateway(
    party: string,
    contractId: string,
  ): Promise<void> {
    const credentials = options.resolveCredentials(party);

    if (!credentials.appToken) {
      throw new Error(
        `Recipient auto-accept requires an appToken for ${party}. ` +
        'Provide it in CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON.',
      );
    }

    const prepared = await requestJson<{
      readonly sessionId?: string;
      readonly expectedPublicKey?: string;
      readonly prepared?: {
        readonly preparedTransactionHash?: string;
      };
    }>(
      fetchImpl,
      `${baseUrl}/api/wallet-gateway/prepare-action`,
      credentials.appToken,
      {
        method: 'POST',
        body: {
          action: 'transfer_accept',
          party,
          requestId: `streams-transfer-accept-${Date.now()}`,
          payload: {
            contractId,
          },
        },
      },
    );

    const preparedHash = trimToUndefined(prepared.prepared?.preparedTransactionHash);
    const sessionId = trimToUndefined(prepared.sessionId);
    const expectedPublicKey = trimToUndefined(prepared.expectedPublicKey);

    if (!preparedHash || !sessionId) {
      throw new Error(
        `wallet-gateway prepare-action did not return a signable transfer_accept session for ${party}.`,
      );
    }

    if (expectedPublicKey && expectedPublicKey !== credentials.publicKey) {
      throw new Error(
        `wallet-gateway expected recipient public key ${expectedPublicKey}, ` +
        `but the configured signer for ${party} uses ${credentials.publicKey}.`,
      );
    }

    await requestJson(
      fetchImpl,
      `${baseUrl}/api/wallet-gateway/execute-action`,
      credentials.appToken,
      {
        method: 'POST',
        body: {
          party,
          sessionId,
          publicKey: credentials.publicKey,
          signature: options.signPreparedHash(preparedHash, credentials),
        },
      },
    );
  }

  return {
    adapter: options.adapter,
    listPendingTransfers,
    claimPendingTransfer:
      options.adapter === 'wallet-api-claim'
        ? claimPendingTransferViaWalletApi
        : claimPendingTransferViaWalletGateway,
  };
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string | undefined,
  init: {
    readonly method: 'GET' | 'POST';
    readonly body?: Record<string, unknown>;
  },
): Promise<T> {
  // Never follow a 3xx on an authenticated call (the default redirect
  // replays the Authorization header to the target), and bound the call so
  // a hung wallet host cannot wedge the caller.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'error',
      signal: ac.signal,
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
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
    const rendered =
      typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    throw new Error(`HTTP ${response.status} ${url}: ${rendered}`);
  }

  return (payload ?? {}) as T;
}

function deserializePendingTransfer(raw: unknown): PendingTransferRecord | null {
  const record = asRecord(raw);
  const contractId =
    asText(record['contractId']) ??
    asText(record['contract_id']) ??
    '';
  if (!contractId) {
    return null;
  }

  const amountText =
    asText(record['amount']) ??
    (typeof record['amount'] === 'number' ? String(record['amount']) : undefined);

  return {
    contractId,
    sender: asText(record['sender']) || undefined,
    receiver: asText(record['receiver']) || undefined,
    amount: amountText ? new Decimal(amountText) : undefined,
    requestedAt: record['requestedAt']
      ? deserializeTime(record['requestedAt'])
      : undefined,
    expired: asBoolean(record['expired'], false) || asBoolean(record['isExpired'], false),
  };
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function trimToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
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
